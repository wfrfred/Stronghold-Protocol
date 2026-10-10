import type { BattleState } from "../../../battle/execution/context.js";
import type { EffectLifecycleOperations, EffectTransitionResources } from "./contract.js";
import type { EffectDispatchScope } from "./dispatch.js";
import {
    bindEffectLifetime,
    finishEffects,
    installNewEffect,
    setEffectEnabled,
    setEffectTick,
    updateEffectState,
} from "./lifecycle.js";

export function createEffectOperations(
    readState: () => BattleState,
    resources: EffectTransitionResources,
    tick: number,
    dispatch: EffectDispatchScope,
): EffectLifecycleOperations {
    return {
        install: (unitId, ref, input) => {
            return installNewEffect(readState(), unitId, ref, input, resources, tick, dispatch);
        },
        update: (ref, definition, transition) => {
            updateEffectState(
                readState(),
                ref.unitId,
                ref.effectId,
                definition,
                transition,
                resources,
                tick,
                dispatch,
            );
        },
        setEnabled: (ref, enabled) => {
            setEffectEnabled(readState(), ref, enabled, resources, tick, dispatch);
        },
        setTick: (ref, expires) => {
            setEffectTick(readState(), ref, expires);
        },
        finish: (refs, reason) => {
            finishEffects(readState(), refs, resources, tick, reason, dispatch);
        },
        bind: (ref, lifetime) => {
            return bindEffectLifetime(readState(), ref, lifetime, dispatch);
        },
    };
}
