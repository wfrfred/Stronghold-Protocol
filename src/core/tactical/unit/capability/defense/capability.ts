import type { Context } from "../../query.js";
import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import type { Unit, Definition } from "../../unit.js";

export interface DefenseDefinition {
    readonly defense: number;
    readonly resistance: number;
}

export interface DefenseState {
    readonly defense: readonly contribution.Contribution<contribution.Input<Context>>[];
    readonly resistance: readonly contribution.Contribution<contribution.Input<Context>>[];
}

export interface Defense {
    readonly definition: {
        readonly defense: DefenseDefinition;
    };
    readonly defense: DefenseState;
}

export interface DefendedUnitDefinition extends Definition {
    readonly defense: DefenseDefinition;
}

export function hasDefense<U extends Unit>(unit: U): unit is U & Defense {
    return "defense" in unit && "defense" in unit.definition;
}

export function hasDefenseDefinition(definition: Definition): definition is DefendedUnitDefinition {
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

export function initializeDefenseState(definition?: DefenseDefinition): DefenseState;
export function initializeDefenseState(): DefenseState {
    return {
        defense: [],
        resistance: [],
    };
}

function updateContributions(
    state: DefenseState,
    parameter: keyof DefenseState,
    transition: (entries: DefenseState["defense"]) => DefenseState["defense"],
): DefenseState {
    const current = state[parameter];
    const updated = transition(current);

    return updated === current ? state : { ...state, [parameter]: updated };
}

export function setDefenseContribution(
    state: DefenseState,
    entry: contribution.Contribution<contribution.Input<Context>>,
): DefenseState {
    return updateContributions(state, "defense", (entries) => contribution.set(entries, entry));
}

export function removeDefenseContribution(state: DefenseState, id: string): DefenseState {
    return updateContributions(state, "defense", (entries) => contribution.remove(entries, id));
}

export function setResistanceContribution(
    state: DefenseState,
    entry: contribution.Contribution<contribution.Input<Context>>,
): DefenseState {
    return updateContributions(state, "resistance", (entries) => contribution.set(entries, entry));
}

export function removeResistanceContribution(state: DefenseState, id: string): DefenseState {
    return updateContributions(state, "resistance", (entries) => contribution.remove(entries, id));
}

export function resolveDefenseParameters(
    definition: DefenseDefinition,
    state: DefenseState,
    context: Context,
): DefenseDefinition {
    return {
        defense: Math.max(
            0,
            modifier.apply(
                definition.defense,
                contribution.resolve(state.defense, (value) =>
                    contribution.evaluate(value, context),
                ),
            ),
        ),
        resistance: Math.min(
            100,
            Math.max(
                0,
                modifier.apply(
                    definition.resistance,
                    contribution.resolve(state.resistance, (value) =>
                        contribution.evaluate(value, context),
                    ),
                ),
            ),
        ),
    };
}
