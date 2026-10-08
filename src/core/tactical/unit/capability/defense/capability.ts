import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as contribution from "../../../modifier/contribution.js";
import * as modifier from "../../../modifier/value.js";
import { widenUnit, type StableUnit, type Unit, type UnitDefinition } from "../../unit.js";

export interface DefenseDefinition {
    readonly defense: number;
    readonly resistance: number;
}

export interface DefenseState {
    readonly defense: contribution.State;
    readonly resistance: contribution.State;
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
        assertNonnegativeNumber(value, name);
    }

    return Object.freeze({ defense: definition.defense, resistance: definition.resistance });
}

export function initializeDefenseState(): DefenseState {
    return {
        defense: contribution.create(),
        resistance: contribution.create(),
    };
}

export function copyDefenseState(state: DefenseState): DefenseState {
    return {
        defense: contribution.copy(state.defense),
        resistance: contribution.copy(state.resistance),
    };
}

function updateContributions(
    state: DefenseState,
    parameter: keyof DefenseState,
    transition: contribution.Transition,
): DefenseState {
    const current = state[parameter];
    const updated = transition(current);

    return updated === current ? state : { ...state, [parameter]: updated };
}

export function updateDefenseContributions<U extends Unit>(
    input: U | StableUnit<U>,
    transition: contribution.Transition,
): StableUnit<U> {
    const unit = widenUnit<U>(input);

    if (!hasDefense(unit)) {
        throw new TypeError("defense contributions require Defense capability");
    }

    const defense = updateContributions(unit.defense, "defense", transition);

    return defense === unit.defense ? unit : { ...unit, defense };
}

export function updateResistanceContributions<U extends Unit>(
    input: U | StableUnit<U>,
    transition: contribution.Transition,
): StableUnit<U> {
    const unit = widenUnit<U>(input);

    if (!hasDefense(unit)) {
        throw new TypeError("resistance contributions require Defense capability");
    }

    const defense = updateContributions(unit.defense, "resistance", transition);

    return defense === unit.defense ? unit : { ...unit, defense };
}

export function resolveDefenseParameters(
    definition: DefenseDefinition,
    state: DefenseState,
    evaluate?: contribution.Evaluate,
): DefenseDefinition {
    return {
        defense: Math.max(
            0,
            modifier.apply(definition.defense, contribution.resolve(state.defense, evaluate)),
        ),
        resistance: Math.min(
            100,
            Math.max(
                0,
                modifier.apply(
                    definition.resistance,
                    contribution.resolve(state.resistance, evaluate),
                ),
            ),
        ),
    };
}
