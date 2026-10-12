import { preserveHpRatio } from "./max-hp.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import type { Unit, UnitDefinition } from "../../unit.js";
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
    readonly definition: {
        readonly vitality: VitalityDefinition;
    };
    readonly vitality: VitalityState;
}

export interface VitalUnitDefinition extends UnitDefinition {
    readonly vitality: VitalityDefinition;
}

export type VitalUnit<D extends VitalUnitDefinition = VitalUnitDefinition> = Unit<D> & Vitality;

export function hasVitality<U extends Unit>(unit: U): unit is U & Vitality {
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

function changeMaxHpContributions(
    definition: VitalityDefinition,
    state: VitalityState,
    transition: (
        entries: readonly contribution.Contribution[],
    ) => readonly contribution.Contribution[],
): VitalityState {
    const maxHp = transition(state.maxHp);

    return maxHp === state.maxHp ? state : preserveHpRatio(definition, state, { ...state, maxHp });
}

export function setMaxHpContribution(
    definition: VitalityDefinition,
    state: VitalityState,
    entry: contribution.Contribution,
): VitalityState {
    return changeMaxHpContributions(definition, state, (entries) =>
        contribution.set(entries, entry),
    );
}

export function removeMaxHpContribution(
    definition: VitalityDefinition,
    state: VitalityState,
    id: string,
): VitalityState {
    return changeMaxHpContributions(definition, state, (entries) =>
        contribution.remove(entries, id),
    );
}

export function resolveVitalityMaxHp(definition: VitalityDefinition, state: VitalityState): number {
    return Math.max(1, modifier.apply(definition.maxHp, contribution.resolve(state.maxHp)));
}
