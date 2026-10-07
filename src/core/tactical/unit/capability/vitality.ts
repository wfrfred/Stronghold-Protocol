import {
    copyNumericContributionState,
    createNumericContributionState,
    resolveNumericContributions,
    type NumericContributionEvaluator,
    type NumericContributionState,
    type NumericContributionTransition,
} from "../../modifier/contribution.js";
import { resolveNumericValue } from "../../modifier/numeric.js";
import type { Unit, UnitDefinition } from "../unit.js";

export interface VitalityDefinition {
    readonly maxHp: number;
}

export interface VitalityState {
    readonly hp: number;
    readonly maxHp: NumericContributionState;
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

export function copyVitalityState(state: Readonly<VitalityState>): VitalityState {
    return { ...state, maxHp: copyNumericContributionState(state.maxHp) };
}

export function initializeVitalityState(definition: VitalityDefinition): VitalityState {
    return { hp: definition.maxHp, maxHp: createNumericContributionState() };
}

export function updateVitalityMaxHpContributions(
    state: VitalityState,
    transition: NumericContributionTransition,
): VitalityState {
    const maxHp = transition(state.maxHp);

    return maxHp === state.maxHp ? state : { ...state, maxHp };
}

export function resolveVitalityMaxHp(
    definition: VitalityDefinition,
    state: VitalityState,
    evaluate?: NumericContributionEvaluator,
): number {
    return Math.max(
        1,
        resolveNumericValue(definition.maxHp, resolveNumericContributions(state.maxHp, evaluate)),
    );
}
