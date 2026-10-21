import type { Unit } from "../../unit.js";
import type { State as BattleState, Result } from "../../../battle/state.js";

export type Type = "GROUND" | "AIR";

export interface Definition {
    readonly type: Type;
}

export interface State {
    readonly type: Type;
}

export interface Layer {
    readonly definition: { readonly layer: Definition };
    readonly layer: State;
}

export function hasLayer<U extends Unit>(unit: U): unit is U & Layer {
    return "layer" in unit && "layer" in unit.definition;
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    return { state: battle, value: { type: definition.type } };
}
