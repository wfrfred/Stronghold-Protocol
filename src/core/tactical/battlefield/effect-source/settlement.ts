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

function sourceIds(state: BattleState): readonly MechanismId[] {
    return [...state.battlefield.mechanismIds].sort((left, right) => left - right);
}

function settleSource<S extends object>(
    state: BattleState,
    initialSource: TypedEffectSourceMechanism<S>,
    program: EffectSourceProgram<S>,
    resources: EffectSourceServices,
    tick: number,
    dispatch: EffectDispatchScope | undefined,
    operation: "RECONCILE" | "REGISTER" | "FINISH",
    registrations: readonly UnitId[] = [],
): void {
    if (initialSource.effectSource.finished) {
        return;
    }

    let pendingSource: EffectSourceMechanism | undefined;
    const sourceId = initialSource.id;
    const receivers = new EffectSourceReceiverWork(initialSource.effectSource.receivers);
    let receiversChanged = false;

    const current = () => {
        const source = pendingSource ?? getMechanism(state, sourceId);

        if (source === undefined || !hasEffectSource(source)) {
            throw new TypeError("effect source settlement lost its mechanism");
        }

        return resources.effectSources.typedSource(source, program.ref)!;
    };

    const flush = () => {
        if (pendingSource !== undefined) {
            updateMechanism(state, pendingSource);
            pendingSource = undefined;
        }
    };

    const context = (): EffectSourceContext<S> => ({
        source: current(),
        battlefield: battlefieldView(state),
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
    const flushReceivers = () => {
        if (receiversChanged) {
            const source = current();
            const next: EffectSourceMechanism = {
                ...source,
                effectSource: copyEffectSourceState(source.effectSource),
            };
            pendingSource = next;
        }

        flush();
    };
    const receiverContext = (
        binding: EffectSourceReceiver,
    ): EffectSourceReceiverContext<S> | undefined => {
        const receiver = getUnit(state, binding.unitId);

        return receiver === undefined ? undefined : { ...context(), receiver, binding };
    };
    const retainReceiver = (unitId: UnitId) => {
        if (bindingOf(unitId) === undefined && getUnit(state, unitId) !== undefined) {
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
                state,
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

        if (installed.type === "INSTALLED") {
            bind({ ...bindingOf(unitId)!, address: installed.ref });
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
                finishEffects(
                    state,
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
        flushReceivers();

        return;
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
            const instance = getEffect(state, binding.address);

            if (instance === undefined || instance.finished) {
                bind({ ...binding, address: null });
                binding = bindingOf(binding.unitId)!;
            } else if (!selected.has(binding.unitId) && !(program.keepOnLeave?.(input) ?? false)) {
                flush();
                finishEffects(state, [binding.address], resources, tick, "SOURCE_LEFT", dispatch);
                bind({ ...bindingOf(binding.unitId)!, address: null });
                binding = bindingOf(binding.unitId)!;
            } else if (program.followsSourceActive?.(input) ?? true) {
                flush();
                setEffectEnabled(
                    state,
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

    flushReceivers();
}

function applyToSource(
    state: BattleState,
    sourceId: MechanismId,
    resources: EffectSourceServices,
    tick: number,
    dispatch: EffectDispatchScope | undefined,
    operation: "RECONCILE" | "REGISTER" | "FINISH",
    registrations?: readonly UnitId[],
): void {
    const source = getMechanism(state, sourceId);

    if (source === undefined || !hasEffectSource(source)) {
        return;
    }

    resources.effectSources.withProgram(source, (typed, program) => {
        settleSource(state, typed, program, resources, tick, dispatch, operation, registrations);
    });
}

export function reconcileEffectSources(
    state: BattleState,
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): void {
    const scope = dispatch ?? new EffectDispatchScope();

    for (const id of sourceIds(state)) {
        applyToSource(state, id, resources, tick, scope, "RECONCILE");
    }
}

export function registerEffectSourceUnits(
    state: BattleState,
    unitIds: readonly UnitId[],
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): void {
    if (unitIds.length === 0) {
        return;
    }

    const scope = dispatch ?? new EffectDispatchScope();

    for (const id of sourceIds(state)) {
        applyToSource(state, id, resources, tick, scope, "REGISTER", unitIds);
    }
}

export function setEffectSourceActive(
    state: BattleState,
    sourceId: MechanismId,
    active: boolean,
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): void {
    const source = getMechanism(state, sourceId);

    if (source === undefined || !hasEffectSource(source) || source.effectSource.finished) {
        return;
    }

    updateMechanism(state, { ...source, active });

    applyToSource(
        state,
        sourceId,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
        "RECONCILE",
    );
}

export function finishEffectSource(
    state: BattleState,
    sourceId: MechanismId,
    resources: EffectSourceServices,
    tick: number,
    dispatch?: EffectDispatchScope,
): void {
    applyToSource(
        state,
        sourceId,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
        "FINISH",
    );
}
