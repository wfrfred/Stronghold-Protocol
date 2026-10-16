import type { State as BattleState, Result } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";

export type Side = "ALLY" | "ENEMY" | "NEUTRAL";

export interface Definition {
    readonly side: Side;
}

export interface State {
    readonly side: Side;
}

export interface Allegiance {
    readonly definition: { readonly allegiance: Definition };
    readonly allegiance: State;
}

export function hasAllegiance<U extends Unit>(unit: U): unit is U & Allegiance {
    return "allegiance" in unit && "allegiance" in unit.definition;
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    return { state: battle, value: definition };
}

export function areHostile(left: Unit & Allegiance, right: Unit & Allegiance): boolean {
    return (left.allegiance.side === "ENEMY") !== (right.allegiance.side === "ENEMY");
}
