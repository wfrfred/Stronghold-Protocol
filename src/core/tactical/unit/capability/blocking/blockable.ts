import type { State as BattleState, Result } from "../../../battle/state.js";
import { assertPositiveSafeInteger } from "../../../../common/assert.js";
import type { Unit } from "../../unit.js";

export interface Definition {
    readonly weight: number;
}

export interface State {
    readonly weight: number;
    readonly enabled: boolean;
}

export interface Blockable {
    readonly definition: {
        readonly blockable: Definition;
    };
    readonly blockable: State;
}

export function hasBlockable<U extends Unit>(unit: U): unit is U & Blockable {
    return "blockable" in unit && "blockable" in unit.definition;
}

export function createDefinition(definition: Definition): Definition {
    assertPositiveSafeInteger(definition.weight, "blocking weight");

    return Object.freeze({ ...definition });
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    return { state: battle, value: { weight: definition.weight, enabled: true } };
}
