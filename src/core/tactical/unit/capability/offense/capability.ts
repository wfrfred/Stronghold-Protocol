import { assertNonnegativeNumber } from "../../../../common/assert.js";
import {
    copyNumericContributionState,
    createNumericContributionState,
    resolveNumericContributions,
    type NumericContributionEvaluator,
    type NumericContributionState,
    type NumericContributionTransition,
} from "../../../modifier/contribution.js";
import { resolveNumericValue } from "../../../modifier/numeric.js";
import type { Unit, UnitDefinition } from "../../unit.js";

export interface OffenseDefinition {
    readonly attack: number;
}

export interface OffenseState {
    readonly attack: NumericContributionState;
}

export interface Offense {
    readonly offense: OffenseState;
}

export interface OffensiveUnitDefinition extends UnitDefinition {
    readonly offense: OffenseDefinition;
}

export function hasOffense<U extends Unit>(
    unit: U,
): unit is U & Offense & Unit<U["definition"] & OffensiveUnitDefinition> {
    return "offense" in unit && "offense" in unit.definition;
}

export function hasOffenseDefinition(
    definition: UnitDefinition,
): definition is OffensiveUnitDefinition {
    return "offense" in definition;
}

export function createOffenseDefinition(definition: OffenseDefinition): OffenseDefinition {
    assertNonnegativeNumber(definition.attack, "attack");

    return Object.freeze({ attack: definition.attack });
}

export function initializeOffenseState(): OffenseState {
    return { attack: createNumericContributionState() };
}

export function copyOffenseState(state: OffenseState): OffenseState {
    return { attack: copyNumericContributionState(state.attack) };
}

export function updateOffenseContributions(
    state: OffenseState,
    transition: NumericContributionTransition,
): OffenseState {
    const attack = transition(state.attack);

    return attack === state.attack ? state : { ...state, attack };
}

export function offenseAttackContributions<U extends Unit>(
    unit: U,
    transition: NumericContributionTransition,
): U {
    if (!hasOffense(unit)) {
        throw new TypeError("attack contributions require Offense capability");
    }

    const offense = updateOffenseContributions(unit.offense, transition);

    return offense === unit.offense ? unit : { ...unit, offense };
}

export function resolveOffenseAttack(
    definition: OffenseDefinition,
    state: OffenseState,
    evaluate?: NumericContributionEvaluator,
): number {
    return Math.max(
        0,
        resolveNumericValue(definition.attack, resolveNumericContributions(state.attack, evaluate)),
    );
}
