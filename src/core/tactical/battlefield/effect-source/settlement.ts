import {
    combatWorkView,
    getCombatMechanism,
    getCombatUnit,
    updateCombatMechanism,
    type CombatWork,
} from "../../battle/execution/work.js";
import type { MechanismId } from "../mechanism.js";
import type { UnitId } from "../../unit/unit.js";
import type { EffectDispatchScope } from "../../unit/capability/effects/dispatch.js";
import {
    finishEffect,
    installNewEffect,
    setEffectParticipation,
} from "../../unit/capability/effects/lifecycle.js";
import { getEffect } from "../../unit/capability/effects/query.js";
import type { EffectProgramRef } from "../../unit/capability/effects/program.js";
import type {
    EffectSourceContext,
    EffectSourceProgram,
    EffectSourceReceiverContext,
} from "./program.js";
import type { EffectSourceServices } from "./resources.js";
import {
    copyEffectSourceState,
    hasEffectSource,
    type EffectSourceMechanism,
    type EffectSourceReceiver,
    type EffectSourceStateValue,
    type TypedEffectSourceMechanism,
} from "./state.js";

export type { EffectSourceServices } from "./resources.js";

function sourceIds(work: CombatWork): readonly MechanismId[] {
    const ids = new Set([...work.mechanismView.mechanismIds, ...work.mechanisms.keys()]);

    return [...ids].sort((left, right) => left - right);
}

function settleSource<S extends object>(
    initialWork: CombatWork,
    initialSource: TypedEffectSourceMechanism<S>,
    program: EffectSourceProgram<S>,
    resources: EffectSourceServices,
    tick: number,
    dispatch: EffectDispatchScope | undefined,
    operation: "RECONCILE" | "REGISTER" | "FINISH",
    registrations: readonly UnitId[] = [],
): CombatWork {
    let work = initialWork;
    const sourceId = initialSource.id;

    const current = () => {
        const source = getCombatMechanism(work, sourceId);

        if (source === undefined || !hasEffectSource(source)) {
            throw new TypeError("effect source settlement lost its mechanism");
        }

        return resources.effectSources.typedSource(source, program.ref)!;
    };

    const context = (): EffectSourceContext<S> => ({
        source: current(),
        battlefield: combatWorkView(work),
        tick,
    });

    const patch = (changes: Partial<Omit<EffectSourceStateValue, "programRef" | "state">>) => {
        const source = current();
        const next: EffectSourceMechanism = {
            ...source,
            effectSource: copyEffectSourceState({ ...source.effectSource, ...changes }),
        };
        work = updateCombatMechanism(work, next);
    };

    const bindingOf = (unitId: UnitId) =>
        current().effectSource.receivers.find((binding) => binding.unitId === unitId);

    const bind = (binding: EffectSourceReceiver) => {
        const bindings = current().effectSource.receivers;
        const next = bindings.some((existing) => existing.unitId === binding.unitId)
            ? bindings.map((existing) => (existing.unitId === binding.unitId ? binding : existing))
            : [...bindings, binding].sort((left, right) => left.unitId - right.unitId);

        patch({ receivers: next });
    };
    const receiverContext = (
        binding: EffectSourceReceiver,
    ): EffectSourceReceiverContext<S> | undefined => {
        const receiver = getCombatUnit(work, binding.unitId);

        return receiver === undefined ? undefined : { ...context(), receiver, binding };
    };
    const retainReceiver = (unitId: UnitId) => {
        if (bindingOf(unitId) === undefined && getCombatUnit(work, unitId) !== undefined) {
            bind({ unitId, address: null, installationAttempts: 0 });
        }
    };
    const installReceiver = (unitId: UnitId) => {
        const source = current();
        const binding = bindingOf(unitId);

        if (!source.active || source.effectSource.finished || binding?.address !== null) {
            return;
        }

        const input = receiverContext(binding);

        if (
            input === undefined ||
            (binding.installationAttempts > 0 && !(program.shouldReinstall?.(input) ?? false))
        ) {
            return;
        }

        const installation = program.install(input);

        if (installation === undefined) {
            return;
        }

        bind({ ...binding, installationAttempts: binding.installationAttempts + 1 });

        const installed = installNewEffect(
            work,
            unitId,
            installation.programRef as EffectProgramRef<object>,
            {
                sourceUnitId: source.effectSource.sourceUnitId,
                lifetimeOwner: null,
                expiresAtTick: installation.expiresAtTick,
                ...(installation.initialState === undefined
                    ? {}
                    : { initialState: installation.initialState }),
            },
            resources,
            tick,
            dispatch,
        );

        work = installed.work;

        if (installed.result.type === "INSTALLED") {
            bind({ ...bindingOf(unitId)!, address: installed.result.address });
        }
    };
    const stop = () => {
        if (current().effectSource.finished) {
            return;
        }

        patch({ finished: true });
        work = updateCombatMechanism(work, { ...current(), active: false });

        for (const candidate of current().effectSource.receivers) {
            const binding = bindingOf(candidate.unitId)!;
            const input = receiverContext(binding);

            if (
                binding.address !== null &&
                !(input !== undefined && (program.keepOnFinish?.(input) ?? false))
            ) {
                work = finishEffect(work, binding.address, resources, tick, dispatch);
                bind({ ...bindingOf(binding.unitId)!, address: null });
            }
        }
    };

    if (current().effectSource.finished) {
        return work;
    }
    if (operation === "FINISH" || (program.shouldFinish?.(context()) ?? false)) {
        stop();

        return work;
    }
    if (!current().effectSource.initialized) {
        const initial = program.selectInitial(context());
        patch({ initialized: true });

        for (const unitId of new Set(initial)) {
            retainReceiver(unitId);
        }
    }
    if (operation === "REGISTER" && program.acceptsRegistration !== undefined) {
        for (const unitId of new Set(registrations)) {
            if (bindingOf(unitId) !== undefined) {
                continue;
            }

            const binding = { unitId, address: null, installationAttempts: 0 };
            const input = receiverContext(binding);

            if (input !== undefined && program.acceptsRegistration(input)) {
                retainReceiver(unitId);
            }
        }
    }

    const selected = new Set(
        program.selectCurrent?.(context()) ??
            current().effectSource.receivers.map((binding) => binding.unitId),
    );

    for (const unitId of selected) {
        retainReceiver(unitId);
    }
    for (const candidate of current().effectSource.receivers) {
        let binding = bindingOf(candidate.unitId)!;
        const input = receiverContext(binding);

        if (input === undefined) {
            if (binding.address !== null) {
                bind({ ...binding, address: null });
            }

            continue;
        }
        if (binding.address !== null) {
            const instance = getEffect(work, binding.address);

            if (instance === undefined || instance.finished) {
                bind({ ...binding, address: null });
                binding = bindingOf(binding.unitId)!;
            } else if (!selected.has(binding.unitId) && !(program.keepOnLeave?.(input) ?? false)) {
                work = finishEffect(work, binding.address, resources, tick, dispatch);
                bind({ ...bindingOf(binding.unitId)!, address: null });
                binding = bindingOf(binding.unitId)!;
            } else if (program.followsParticipation?.(input) ?? true) {
                work = setEffectParticipation(
                    work,
                    binding.address,
                    current().active,
                    resources,
                    tick,
                    dispatch,
                );
            }
        }
        if (selected.has(binding.unitId)) {
            installReceiver(binding.unitId);
        }
    }

    return work;
}

function applyToSource(
    work: CombatWork,
    sourceId: MechanismId,
    resources: EffectSourceServices,
    tick: number,
    dispatch: EffectDispatchScope | undefined,
    operation: "RECONCILE" | "REGISTER" | "FINISH",
    registrations?: readonly UnitId[],
): CombatWork {
    const source = getCombatMechanism(work, sourceId);

    if (source === undefined || !hasEffectSource(source)) {
        return work;
    }

    return resources.effectSources.withProgram(source, (typed, program) =>
        settleSource(work, typed, program, resources, tick, dispatch, operation, registrations),
    );
}

export function reconcileEffectSources(
    work: CombatWork,
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    for (const id of sourceIds(work)) {
        work = applyToSource(work, id, resources, tick, dispatch, "RECONCILE");
    }

    return work;
}

export function registerEffectSourceUnits(
    work: CombatWork,
    unitIds: readonly UnitId[],
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    if (unitIds.length === 0) {
        return work;
    }
    for (const id of sourceIds(work)) {
        work = applyToSource(work, id, resources, tick, dispatch, "REGISTER", unitIds);
    }

    return work;
}

export function setEffectSourceActive(
    work: CombatWork,
    sourceId: MechanismId,
    active: boolean,
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    const source = getCombatMechanism(work, sourceId);

    if (source === undefined || !hasEffectSource(source) || source.effectSource.finished) {
        return work;
    }

    work = updateCombatMechanism(work, { ...source, active });

    return applyToSource(work, sourceId, resources, tick, dispatch, "RECONCILE");
}

export function finishEffectSource(
    work: CombatWork,
    sourceId: MechanismId,
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    return applyToSource(work, sourceId, resources, tick, dispatch, "FINISH");
}
