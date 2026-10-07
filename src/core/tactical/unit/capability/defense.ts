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

export interface DefenseDefinition {
    readonly defense: number;
    readonly resistance: number;
}

export interface DefenseState {
    readonly defense: NumericContributionState;
    readonly resistance: NumericContributionState;
}

export interface Defense {
    readonly defense: DefenseState;
}

export interface DefendedUnitDefinition extends UnitDefinition {
    readonly defense: DefenseDefinition;
}

export function hasDefense<U extends Unit>(
    unit: U,
): unit is U & Defense & Unit<U["definition"] & DefendedUnitDefinition> {
    return "defense" in unit && "defense" in unit.definition;
}

export function hasDefenseDefinition(
    definition: UnitDefinition,
): definition is DefendedUnitDefinition {
    return "defense" in definition;
}

export function createDefenseDefinition(definition: DefenseDefinition): DefenseDefinition {
    for (const [name, value] of [
        ["defense", definition.defense],
        ["resistance", definition.resistance],
    ] as const) {
        if (!Number.isFinite(value) || value < 0) {
            throw new RangeError(`${name} must be finite and nonnegative`);
        }
    }

    return Object.freeze({ defense: definition.defense, resistance: definition.resistance });
}

export function initializeDefenseState(): DefenseState {
    return {
        defense: createNumericContributionState(),
        resistance: createNumericContributionState(),
    };
}

export function copyDefenseState(state: DefenseState): DefenseState {
    return {
        defense: copyNumericContributionState(state.defense),
        resistance: copyNumericContributionState(state.resistance),
    };
}

export function updateDefenseContributions(
    state: DefenseState,
    parameter: keyof DefenseState,
    transition: NumericContributionTransition,
): DefenseState {
    const current = state[parameter];
    const updated = transition(current);

    return updated === current ? state : { ...state, [parameter]: updated };
}

export function resolveDefenseParameters(
    definition: DefenseDefinition,
    state: DefenseState,
    evaluate?: NumericContributionEvaluator,
): DefenseDefinition {
    return {
        defense: Math.max(
            0,
            resolveNumericValue(
                definition.defense,
                resolveNumericContributions(state.defense, evaluate),
            ),
        ),
        resistance: Math.max(
            0,
            resolveNumericValue(
                definition.resistance,
                resolveNumericContributions(state.resistance, evaluate),
            ),
        ),
    };
}
