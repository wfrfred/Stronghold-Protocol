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
    getWork: () => BattleState,
    resources: EffectTransitionResources,
    tick: number,
    dispatch: EffectDispatchScope,
): EffectLifecycleOperations {
    return {
        install: (unitId, ref, input) => {
            const installation = installNewEffect(
                getWork(),
                unitId,
                ref,
                input,
                resources,
                tick,
                dispatch,
            );

            return installation.result;
        },
        update: (ref, program, transition) => {
            updateEffectState(
                getWork(),
                ref.unitId,
                ref.effectId,
                program,
                transition,
                resources,
                tick,
                dispatch,
            );
        },
        setEnabled: (ref, enabled) => {
            setEffectEnabled(getWork(), ref, enabled, resources, tick, dispatch);
        },
        setTick: (ref, expires) => {
            setEffectTick(getWork(), ref, expires);
        },
        finish: (refs, reason) => {
            finishEffects(getWork(), refs, resources, tick, reason, dispatch);
        },
        bind: (ref, lifetime) => {
            const binding = bindEffectLifetime(getWork(), ref, lifetime, dispatch);

            return binding.result;
        },
    };
}
