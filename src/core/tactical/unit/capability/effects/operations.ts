import type { CombatWork } from "../../../battle/execution/work.js";
import type { EffectLifecycleOperations, EffectTransitionResources } from "./contract.js";
import type { EffectDispatchScope } from "./dispatch.js";
import {
    attachEffectParent,
    finishEffect,
    installNewEffect,
    setEffectParticipation,
} from "./lifecycle.js";
import { updateEffectState } from "./transition.js";

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
                ),
            );
        },
        setParticipation: (address, participating) => {
            setWork(
                setEffectParticipation(
                    getWork(),
                    address,
                    participating,
                    resources,
                    tick,
                    dispatch,
                ),
            );
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
