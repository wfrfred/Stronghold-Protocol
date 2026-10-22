import type { State as BattleState, Result } from "../../../battle/state.js";
import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as contribution from "../../contribution/contribution.js";
import * as attribute from "../../contribution/attribute.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";

export interface Definition {
    readonly attack: number;
}

export type Input =
    | readonly attribute.Modifier[]
    | ((battle: BattleState, self: Unit & Offense) => readonly attribute.Modifier[]);

export interface State {
    readonly attack: readonly contribution.Contribution<Input>[];
}

export interface Offense {
    readonly definition: {
        readonly offense: Definition;
    };
    readonly offense: State;
}

export function hasOffense<U extends Unit>(unit: U): unit is U & Offense {
    return "offense" in unit && "offense" in unit.definition;
}

export function hasOffenseDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Offense["definition"] {
    return "offense" in definition;
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    assertNonnegativeNumber(definition.attack, "attack");

    return { state: battle, value: { attack: [] } };
}

function changeAttackContributions(
    state: State,
    transition: (entries: State["attack"]) => State["attack"],
): State {
    const attack = transition(state.attack);

    return attack === state.attack ? state : { ...state, attack };
}

export function setAttackContribution(
    state: State,
    entry: contribution.Contribution<Input>,
): State {
    return changeAttackContributions(state, (entries) => contribution.set(entries, entry));
}

export function removeAttackContribution(state: State, id: string): State {
    return changeAttackContributions(state, (entries) => contribution.remove(entries, id));
}
