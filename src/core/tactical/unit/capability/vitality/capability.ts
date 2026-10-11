import { preserveHpRatio } from "./max-hp.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import { widenUnit, type StableUnit, type Unit, type UnitDefinition } from "../../unit.js";
import type { Hook as DamageHook } from "./damage/hook.js";
import type { Hook as HealingHook } from "./healing/hook.js";

export interface VitalityDefinition {
    readonly maxHp: number;
}

export interface VitalityState {
    readonly hp: number;
    readonly maxHp: readonly contribution.Contribution[];
    readonly damageHooks: readonly DamageHook[];
    readonly healingHooks: readonly HealingHook[];
}

export interface Vitality {
    readonly vitality: VitalityState;
}

export interface VitalUnitDefinition extends UnitDefinition {
    readonly vitality: VitalityDefinition;
}

export type VitalUnit<D extends VitalUnitDefinition = VitalUnitDefinition> = Unit<D> & Vitality;

export function hasVitality<U extends Unit>(
    unit: U,
): unit is U & VitalUnit<U["definition"] & VitalUnitDefinition> {
    return "vitality" in unit && "vitality" in unit.definition;
}

export function hasVitalityDefinition(
    definition: UnitDefinition,
): definition is VitalUnitDefinition {
    return "vitality" in definition;
}

export function initializeVitalityState(definition: VitalityDefinition): VitalityState {
    return { hp: definition.maxHp, maxHp: [], damageHooks: [], healingHooks: [] };
}

function changeMaxHpContributions<U extends Unit>(
    input: U | StableUnit<U>,
    transition: (
        entries: readonly contribution.Contribution[],
    ) => readonly contribution.Contribution[],
): StableUnit<U> {
    const unit = widenUnit<U>(input);

    if (!hasVitality(unit)) {
        throw new TypeError("maximum HP contributions require Vitality capability");
    }

    const maxHp = transition(unit.vitality.maxHp);

    return maxHp === unit.vitality.maxHp
        ? unit
        : preserveHpRatio<U>(unit, { ...unit, vitality: { ...unit.vitality, maxHp } });
}

export function setMaxHpContribution<U extends Unit>(
    unit: U | StableUnit<U>,
    entry: contribution.Contribution,
): StableUnit<U> {
    return changeMaxHpContributions<U>(unit, (entries) => contribution.set(entries, entry));
}

export function removeMaxHpContribution<U extends Unit>(
    unit: U | StableUnit<U>,
    id: string,
): StableUnit<U> {
    return changeMaxHpContributions<U>(unit, (entries) => contribution.remove(entries, id));
}

export function resolveVitalityMaxHp(definition: VitalityDefinition, state: VitalityState): number {
    return Math.max(1, modifier.apply(definition.maxHp, contribution.resolve(state.maxHp)));
}
