import type { UnitId } from "../../unit.js";
import type {
    EffectFacts,
    EffectLifecycleOperations,
    EffectTransitionResources,
} from "../effects/contract.js";
import type { EffectAddress, EffectInstance, EffectInstanceValue } from "../effects/instance.js";
import { createEffectOperations } from "../effects/operations.js";
import { EffectDispatchScope } from "../effects/dispatch.js";
import { effectFacts, getEffect } from "../effects/query.js";
import { resolveMaxHp } from "./query.js";
import { combatWorkView, type CombatWork } from "../../../battle/execution/work.js";
import type { DamageReport, DamageRequest, DamageResolution } from "./damage/contract.js";
import type { HealingReport, HealingRequest, HealingResolution } from "./healing/contract.js";
import {
    createEffectSourceOperations,
    type EffectSourceOperations,
} from "../../../battlefield/effect-source/operations.js";
import type { EffectSourceResources } from "../../../battlefield/effect-source/resources.js";

export interface VitalityHookFacts extends EffectFacts {
    maxHp(unitId: UnitId): number | undefined;
}

export interface VitalityHookContext<S extends object> {
    readonly address: EffectAddress;
    readonly ownerUnitId: UnitId;
    readonly instance: EffectInstance<S>;
    readonly tick: number;
    readonly facts: VitalityHookFacts;
}

export interface VitalityHookOperations {
    readonly effects: EffectLifecycleOperations;
    readonly sources: EffectSourceOperations;
    damage(request: DamageRequest): DamageReport;
    heal(request: HealingRequest): HealingReport;
}

export type DamageOperation = (
    work: CombatWork,
    request: DamageRequest,
    dispatch: EffectDispatchScope,
) => DamageResolution;

export type HealingOperation = (
    work: CombatWork,
    request: HealingRequest,
    tick: number,
    dispatch: EffectDispatchScope,
) => HealingResolution;

export function vitalityHookFacts(work: () => CombatWork): VitalityHookFacts {
    return {
        ...effectFacts(work),
        maxHp: (unitId) => resolveMaxHp(unitId, combatWorkView(work())),
    };
}

export interface DispatchResult<V> {
    readonly value: V;
    readonly stopDispatch?: boolean;
}

export interface VitalityHookServices extends EffectTransitionResources {
    readonly effectSources: EffectSourceResources;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}

export type VitalityHookInvocation<R> = Omit<VitalityHookContext<object>, "instance"> & {
    readonly instance: EffectInstanceValue;
    readonly request: R;
    readonly operations: VitalityHookOperations;
};

export function withVitalityHookContext<R, T>(
    getWork: () => CombatWork,
    setWork: (work: CombatWork) => void,
    address: EffectAddress,
    instance: EffectInstanceValue,
    request: R,
    resources: VitalityHookServices,
    tick: number,
    dispatch: EffectDispatchScope,
    run: (context: VitalityHookInvocation<R>) => T,
): T {
    return dispatch.withInstance(address, instance, (lastKnown) => {
        let active = true;

        const readWork = (): CombatWork => {
            if (!active) {
                throw new TypeError("vitality hook context is no longer active");
            }

            return getWork();
        };

        const context: VitalityHookInvocation<R> = {
            address,
            ownerUnitId: address.unitId,
            get instance() {
                return getEffect(readWork(), address) ?? lastKnown();
            },
            request,
            tick,
            facts: vitalityHookFacts(readWork),
            operations: {
                effects: createEffectOperations(readWork, setWork, resources, tick, dispatch),
                sources: createEffectSourceOperations(readWork, setWork, resources),
                damage: (input) => {
                    const result = resources.settleDamage(readWork(), input, dispatch);
                    setWork(result.work);

                    return result.report;
                },
                heal: (input) => {
                    const result = resources.settleHealing(readWork(), input, tick, dispatch);
                    setWork(result.work);

                    return result.report;
                },
            },
        };

        try {
            return run(context);
        } finally {
            active = false;
        }
    });
}
