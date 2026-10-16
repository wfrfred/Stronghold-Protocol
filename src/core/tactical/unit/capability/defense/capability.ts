import type { State as BattleState, Result } from "../../../battle/state.js";
import type { Context } from "../../query.js";
import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as contribution from "../../contribution/contribution.js";
import * as attribute from "../../contribution/attribute.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";

export interface Parameters {
    readonly defense: number;
    readonly resistance: number;
}

export type Definition = Parameters;

export interface State {
    readonly defense: readonly contribution.Contribution<attribute.Input<Context>>[];
    readonly resistance: readonly contribution.Contribution<attribute.Input<Context>>[];
}

export interface Defense {
    readonly definition: {
        readonly defense: Definition;
    };
    readonly defense: State;
}

export function hasDefense<U extends Unit>(unit: U): unit is U & Defense {
    return "defense" in unit && "defense" in unit.definition;
}

export function hasDefenseDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Defense["definition"] {
    return "defense" in definition;
}

export function createDefinition(definition: Definition): Definition {
    for (const [name, value] of [
        ["defense", definition.defense],
        ["resistance", definition.resistance],
    ] as const) {
        assertNonnegativeNumber(value, name);
    }

    return Object.freeze({ defense: definition.defense, resistance: definition.resistance });
}

export const initialize: (battle: BattleState, definition: Definition) => Result<State> = (
    battle,
) => {
    return {
        state: battle,
        value: {
            defense: [],
            resistance: [],
        },
    };
};

function updateContributions(
    state: State,
    parameter: keyof State,
    transition: (entries: State["defense"]) => State["defense"],
): State {
    const current = state[parameter];
    const updated = transition(current);

    return updated === current ? state : { ...state, [parameter]: updated };
}

export function setDefenseContribution(
    state: State,
    entry: contribution.Contribution<attribute.Input<Context>>,
): State {
    return updateContributions(state, "defense", (entries) => contribution.set(entries, entry));
}

export function removeDefenseContribution(state: State, id: string): State {
    return updateContributions(state, "defense", (entries) => contribution.remove(entries, id));
}

export function setResistanceContribution(
    state: State,
    entry: contribution.Contribution<attribute.Input<Context>>,
): State {
    return updateContributions(state, "resistance", (entries) => contribution.set(entries, entry));
}

export function removeResistanceContribution(state: State, id: string): State {
    return updateContributions(state, "resistance", (entries) => contribution.remove(entries, id));
}

export function resolveParameters(
    definition: Definition,
    state: State,
    context: Context,
): Parameters {
    return {
        defense: Math.max(
            0,
            attribute.apply(
                definition.defense,
                contribution
                    .resolve(state.defense)
                    .flatMap((value) => attribute.evaluate(value, context)),
            ),
        ),
        resistance: Math.min(
            100,
            Math.max(
                0,
                attribute.apply(
                    definition.resistance,
                    contribution
                        .resolve(state.resistance)
                        .flatMap((value) => attribute.evaluate(value, context)),
                ),
            ),
        ),
    };
}
