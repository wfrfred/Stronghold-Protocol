import type { QueryContext } from "../../query.js";
import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as contribution from "../../../contribution/contribution.js";
import * as modifier from "../../../contribution/value.js";
import { widenUnit, type StableUnit, type Unit, type UnitDefinition } from "../../unit.js";

export interface DefenseDefinition {
    readonly defense: number;
    readonly resistance: number;
}

export interface DefenseState {
    readonly defense: readonly contribution.Contribution<contribution.Input<QueryContext>>[];
    readonly resistance: readonly contribution.Contribution<contribution.Input<QueryContext>>[];
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

function changeContributions<U extends Unit>(
    input: U | StableUnit<U>,
    parameter: keyof DefenseState,
    transition: (entries: DefenseState["defense"]) => DefenseState["defense"],
): StableUnit<U> {
    const unit = widenUnit<U>(input);

    if (!hasDefense(unit)) {
        throw new TypeError("defense contributions require Defense capability");
    }

    const defense = updateContributions(unit.defense, parameter, transition);

    return defense === unit.defense ? unit : { ...unit, defense };
}

export function setDefenseContribution<U extends Unit>(
    unit: U | StableUnit<U>,
    entry: contribution.Contribution<contribution.Input<QueryContext>>,
): StableUnit<U> {
    return changeContributions<U>(unit, "defense", (entries) => contribution.set(entries, entry));
}

export function removeDefenseContribution<U extends Unit>(
    unit: U | StableUnit<U>,
    id: string,
): StableUnit<U> {
    return changeContributions<U>(unit, "defense", (entries) => contribution.remove(entries, id));
}

export function setResistanceContribution<U extends Unit>(
    unit: U | StableUnit<U>,
    entry: contribution.Contribution<contribution.Input<QueryContext>>,
): StableUnit<U> {
    return changeContributions<U>(unit, "resistance", (entries) =>
        contribution.set(entries, entry),
    );
}

export function removeResistanceContribution<U extends Unit>(
    unit: U | StableUnit<U>,
    id: string,
): StableUnit<U> {
    return changeContributions<U>(unit, "resistance", (entries) =>
        contribution.remove(entries, id),
    );
}

export function resolveDefenseParameters(
    definition: DefenseDefinition,
    state: DefenseState,
    context: QueryContext,
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
