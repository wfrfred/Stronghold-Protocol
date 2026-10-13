import type { Context } from "../../query.js";
import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import type { Unit, Definition } from "../../unit.js";

export interface OffenseDefinition {
    readonly attack: number;
}

export interface OffenseState {
    readonly attack: readonly contribution.Contribution<contribution.Input<Context>>[];
}

export interface Offense {
    readonly definition: {
        readonly offense: OffenseDefinition;
    };
    readonly offense: OffenseState;
}

export function hasOffense<U extends Unit>(unit: U): unit is U & Offense {
    return "offense" in unit && "offense" in unit.definition;
}

export function hasOffenseDefinition(
    definition: Definition,
): definition is Definition & Offense["definition"] {
    return "offense" in definition;
}

export function createOffenseDefinition(definition: OffenseDefinition): OffenseDefinition {
    assertNonnegativeNumber(definition.attack, "attack");

    return Object.freeze({ attack: definition.attack });
}

export function initializeOffenseState(): OffenseState {
    return { attack: [] };
}

function changeAttackContributions(
    state: OffenseState,
    transition: (entries: OffenseState["attack"]) => OffenseState["attack"],
): OffenseState {
    const attack = transition(state.attack);

    return attack === state.attack ? state : { ...state, attack };
}

export function setAttackContribution(
    state: OffenseState,
    entry: contribution.Contribution<contribution.Input<Context>>,
): OffenseState {
    return changeAttackContributions(state, (entries) => contribution.set(entries, entry));
}

export function removeAttackContribution(state: OffenseState, id: string): OffenseState {
    return changeAttackContributions(state, (entries) => contribution.remove(entries, id));
}

export function resolveOffenseAttack(
    definition: OffenseDefinition,
    state: OffenseState,
    context: Context,
): number {
    return Math.max(
        0,
        modifier.apply(
            definition.attack,
            contribution.resolve(state.attack, (value) => contribution.evaluate(value, context)),
        ),
    );
}
