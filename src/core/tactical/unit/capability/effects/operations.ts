import type { CombatWork } from "../../../battle/execution/work.js";
import type { EffectLifecycleOperations, EffectTransitionResources } from "./contract.js";
import type { EffectDispatchScope } from "./dispatch.js";
import {
    attachEffectParent,
    finishEffect,
    installNewEffect,
    setEffectEnabled,
    setEffectExpiration,
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
        update: (address, ref, transition) => {
            setWork(
                updateEffectState(
                    getWork(),
                    address.unitId,
                    address.instanceId,
                    ref,
                    transition,
                    resources,
                    tick,
                    dispatch,
                ),
            );
        },
        setEnabled: (address, enabled) => {
            setWork(setEffectEnabled(getWork(), address, enabled, resources, tick, dispatch));
        },
        setExpiration: (address, expiresAtTick) => {
            setWork(setEffectExpiration(getWork(), address, expiresAtTick));
        },
        finish: (address) => {
            setWork(finishEffect(getWork(), address, resources, tick, dispatch));
        },
        attachParent: (child, parent, finishIfParentFinished) => {
            const binding = attachEffectParent(
                getWork(),
                child,
                parent,
                resources,
                tick,
                finishIfParentFinished,
                dispatch,
            );
            setWork(binding.work);

            return binding.result;
        },
    };
}
