import type { UnitId } from "../../unit.js";
import type {
    EffectFacts,
    EffectLifecycleOperations,
    EffectTransitionResources,
} from "../effects/contract.js";
import type { EffectAddress, EffectInstance, EffectInstanceValue } from "../effects/instance.js";
import { createEffectOperations } from "../effects/operations.js";
import { EffectDispatchScope, effectDispatchFacts } from "../effects/dispatch.js";
import { effectFacts, getEffect } from "../effects/query.js";
import { resolveMaxHp } from "./query.js";
import { hasVitality } from "./capability.js";
import type { NumericContributionProvider } from "../../../modifier/providers.js";
import type { NumericProviderFacts } from "../contribution.js";
import { combatWorkView, getCombatUnit, type CombatWork } from "../../../battle/execution/work.js";
import type { DamageReport, DamageRequest, DamageResolution } from "./damage/contract.js";
import type { HealingReport, HealingRequest, HealingResolution } from "./healing/contract.js";

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

export function vitalityHookFacts(
    work: () => CombatWork,
    vitality: NumericContributionProvider<NumericProviderFacts>,
    dispatch: EffectDispatchScope,
): VitalityHookFacts {
    return {
        ...effectDispatchFacts(() => effectFacts(work), dispatch),
        maxHp: (unitId) => {
            const current = work();
            const unit = getCombatUnit(current, unitId);

            return unit !== undefined && hasVitality(unit)
                ? resolveMaxHp(unitId, combatWorkView(current), vitality)
                : undefined;
        },
    };
}

export interface DispatchResult<V> {
    readonly value: V;
    readonly stopDispatch?: boolean;
}

export interface VitalityHookServices extends EffectTransitionResources {
    readonly vitality: NumericContributionProvider<NumericProviderFacts>;
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
    return dispatch.withInstance(address, instance, (lastKnown) =>
        run({
            address,
            ownerUnitId: address.unitId,
            get instance() {
                return getEffect(getWork(), address) ?? lastKnown();
            },
            request,
            tick,
            facts: vitalityHookFacts(getWork, resources.vitality, dispatch),
            operations: {
                effects: createEffectOperations(getWork, setWork, resources, tick, dispatch),
                damage: (input) => {
                    const result = resources.settleDamage(getWork(), input, dispatch);
                    setWork(result.work);

                    return result.report;
                },
                heal: (input) => {
                    const result = resources.settleHealing(getWork(), input, tick, dispatch);
                    setWork(result.work);

                    return result.report;
                },
            },
        }),
    );
}
