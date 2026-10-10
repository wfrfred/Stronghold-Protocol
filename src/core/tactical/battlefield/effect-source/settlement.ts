import {
    battlefieldView,
    getMechanism,
    getUnit,
    updateMechanism,
    type BattleState,
} from "../../battle/execution/context.js";
import type { MechanismId } from "../mechanism.js";
import type { UnitId } from "../../unit/unit.js";
import { EffectDispatchScope } from "../../unit/capability/effects/dispatch.js";
import {
    finishEffects,
    installNewEffect,
    setEffectEnabled,
} from "../../unit/capability/effects/lifecycle.js";
import { getEffect } from "../../unit/capability/effects/query.js";
import type {
    EffectSourceContext,
    EffectSourceProgram,
    EffectSourceReceiverContext,
} from "./program.js";
import type { EffectSourceServices } from "./resources.js";
import {
    EffectSourceReceiverWork,
    updateEffectSourceReceiverView,
    createEffectSourceReceiverView,
} from "./internal/receivers.js";
import {
    copyEffectSourceState,
    hasEffectSource,
    type EffectSourceMechanism,
    type EffectSourceReceiver,
    type EffectSourceStateValue,
    type TypedEffectSourceMechanism,
} from "./state.js";

export type { EffectSourceServices } from "./resources.js";

function sourceIds(work: BattleState): readonly MechanismId[] {
    return [...work.battlefield.mechanismIds].sort((left, right) => left - right);
}

function settleSource<S extends object>(
    initialWork: BattleState,
    initialSource: TypedEffectSourceMechanism<S>,
    program: EffectSourceProgram<S>,
    resources: EffectSourceServices,
    tick: number,
    dispatch: EffectDispatchScope | undefined,
    operation: "RECONCILE" | "REGISTER" | "FINISH",
    registrations: readonly UnitId[] = [],
): BattleState {
    if (initialSource.effectSource.finished) {
        return initialWork;
    }

    let work = initialWork;
    let pendingSource: EffectSourceMechanism | undefined;
    const sourceId = initialSource.id;
    const receivers = new EffectSourceReceiverWork(initialSource.effectSource.receivers);
    let receiversChanged = false;

    const current = () => {
        const source = pendingSource ?? getMechanism(work, sourceId);

        if (source === undefined || !hasEffectSource(source)) {
            throw new TypeError("effect source settlement lost its mechanism");
        }

        return resources.effectSources.typedSource(source, program.ref)!;
    };

    const flush = () => {
        if (pendingSource !== undefined) {
            work = updateMechanism(work, pendingSource);
            pendingSource = undefined;
        }
    };

    const context = (): EffectSourceContext<S> => ({
        source: current(),
        battlefield: battlefieldView(work),
        tick,
    });

    const patch = (changes: Partial<Pick<EffectSourceStateValue, "initialized" | "finished">>) => {
        const source = current();
        const next: EffectSourceMechanism = {
            ...source,
            effectSource:
                updateEffectSourceReceiverView(source.effectSource, changes) ??
                copyEffectSourceState({ ...source.effectSource, ...changes }),
        };
        pendingSource = next;
    };

    const bindingOf = (unitId: UnitId) => receivers.get(unitId);

    const bind = (binding: EffectSourceReceiver) => {
        const source = current();
        const readReceivers = receivers.set(binding);
        receiversChanged = true;

        const next: EffectSourceMechanism = {
            ...source,
            effectSource: createEffectSourceReceiverView(source.effectSource, readReceivers),
        };
        pendingSource = next;
    };
    const finishWork = () => {
        if (receiversChanged) {
            const source = current();
            const next: EffectSourceMechanism = {
                ...source,
                effectSource: copyEffectSourceState(source.effectSource),
            };
            pendingSource = next;
        }

        flush();

        return work;
    };
    const receiverContext = (
        binding: EffectSourceReceiver,
    ): EffectSourceReceiverContext<S> | undefined => {
        const receiver = getUnit(work, binding.unitId);

        return receiver === undefined ? undefined : { ...context(), receiver, binding };
    };
    const retainReceiver = (unitId: UnitId) => {
        if (bindingOf(unitId) === undefined && getUnit(work, unitId) !== undefined) {
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
        flush();

        const installed = installation((ref, initial) =>
            installNewEffect(
                work,
                unitId,
                ref,
                {
                    source: source.effectSource.sourceUnitId,
                    scopes: initial.scopes,
                    ...(initial.initialState === undefined
                        ? {}
                        : { initialState: initial.initialState }),
                },
                resources,
                tick,
                dispatch,
            ),
        );

        work = installed.work;

        if (installed.result.type === "INSTALLED") {
            bind({ ...bindingOf(unitId)!, address: installed.result.ref });
        }
    };
    const stop = () => {
        if (current().effectSource.finished) {
            return;
        }

        patch({ finished: true });
        pendingSource = { ...current(), active: false };

        for (const unitId of receivers.ids()) {
            const binding = bindingOf(unitId)!;
            const input = receiverContext(binding);

            if (
                binding.address !== null &&
                !(input !== undefined && (program.keepOnFinish?.(input) ?? false))
            ) {
                flush();
                work = finishEffects(
                    work,
                    [binding.address],
                    resources,
                    tick,
                    "SOURCE_FINISHED",
                    dispatch,
                );
                bind({ ...bindingOf(binding.unitId)!, address: null });
            }
        }
    };

    if (operation === "FINISH" || (program.shouldFinish?.(context()) ?? false)) {
        stop();

        return finishWork();
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

    const selected = new Set(program.selectCurrent?.(context()) ?? receivers.ids());

    for (const unitId of selected) {
        retainReceiver(unitId);
    }
    for (const unitId of receivers.ids()) {
        let binding = bindingOf(unitId)!;
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
                flush();
                work = finishEffects(
                    work,
                    [binding.address],
                    resources,
                    tick,
                    "SOURCE_LEFT",
                    dispatch,
                );
                bind({ ...bindingOf(binding.unitId)!, address: null });
                binding = bindingOf(binding.unitId)!;
            } else if (program.followsSourceActive?.(input) ?? true) {
                flush();
                work = setEffectEnabled(
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

    return finishWork();
}

function applyToSource(
    work: BattleState,
    sourceId: MechanismId,
    resources: EffectSourceServices,
    tick: number,
    dispatch: EffectDispatchScope | undefined,
    operation: "RECONCILE" | "REGISTER" | "FINISH",
    registrations?: readonly UnitId[],
): BattleState {
    const source = getMechanism(work, sourceId);

    if (source === undefined || !hasEffectSource(source)) {
        return work;
    }

    return resources.effectSources.withProgram(source, (typed, program) =>
        settleSource(work, typed, program, resources, tick, dispatch, operation, registrations),
    );
}

export function reconcileEffectSources(
    work: BattleState,
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): BattleState {
    const scope = dispatch ?? new EffectDispatchScope();

    for (const id of sourceIds(work)) {
        work = applyToSource(work, id, resources, tick, scope, "RECONCILE");
    }

    return work;
}

export function registerEffectSourceUnits(
    work: BattleState,
    unitIds: readonly UnitId[],
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): BattleState {
    if (unitIds.length === 0) {
        return work;
    }

    const scope = dispatch ?? new EffectDispatchScope();

    for (const id of sourceIds(work)) {
        work = applyToSource(work, id, resources, tick, scope, "REGISTER", unitIds);
    }

    return work;
}

export function setEffectSourceActive(
    work: BattleState,
    sourceId: MechanismId,
    active: boolean,
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): BattleState {
    const source = getMechanism(work, sourceId);

    if (source === undefined || !hasEffectSource(source) || source.effectSource.finished) {
        return work;
    }

    work = updateMechanism(work, { ...source, active });

    return applyToSource(
        work,
        sourceId,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
        "RECONCILE",
    );
}

export function finishEffectSource(
    work: BattleState,
    sourceId: MechanismId,
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): BattleState {
    return applyToSource(
        work,
        sourceId,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
        "FINISH",
    );
}
