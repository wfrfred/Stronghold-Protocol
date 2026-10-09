import type { CombatWork } from "../../../battle/execution/work.js";
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
    getWork: () => CombatWork,
    setWork: (work: CombatWork) => void,
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
            setWork(installation.work);

            return installation.result;
        },
        update: (ref, program, transition) => {
            setWork(
                updateEffectState(
                    getWork(),
                    ref.unitId,
                    ref.effectId,
                    program,
                    transition,
                    resources,
                    tick,
                    dispatch,
                ),
            );
        },
        setEnabled: (ref, enabled) => {
            setWork(setEffectEnabled(getWork(), ref, enabled, resources, tick, dispatch));
        },
        setTick: (ref, expires) => {
            setWork(setEffectTick(getWork(), ref, expires));
        },
        finish: (refs, reason) => {
            setWork(finishEffects(getWork(), refs, resources, tick, reason, dispatch));
        },
        bind: (ref, lifetime) => {
            const binding = bindEffectLifetime(getWork(), ref, lifetime, dispatch);
            setWork(binding.work);

            return binding.result;
        },
    };
}
