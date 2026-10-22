import { validateShape, type Shape } from "../../../geometry/shape.js";
import type { Unit } from "../../unit.js";
import type { State as BattleState, Result } from "../../../battle/state.js";

export interface Definition {
    readonly shape: Shape;
}

export type State = Readonly<Record<string, never>>;

export interface Hitbox {
    readonly definition: { readonly hitbox: Definition };
    readonly hitbox: State;
}

export function hasHitbox<U extends Unit>(unit: U): unit is U & Hitbox {
    return "hitbox" in unit && "hitbox" in unit.definition;
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    validateShape(definition.shape);

    return { state: battle, value: {} };
}
