import type { TilePosition } from "../../../geometry/coordinate.js";
import type { Unit } from "../../unit.js";
import type { State as BattleState, Result } from "../../../battle/state.js";

export type Definition = Readonly<Record<string, never>>;

export type Slot = "OCCUPANT" | "SUPPORT";

export interface Registration {
    readonly tile: TilePosition;
    readonly slot: Slot;
}

export interface State {
    readonly registration: Registration | null;
}

export interface Occupancy {
    readonly definition: { readonly occupancy: Definition };
    readonly occupancy: State;
}

export function hasOccupancy<U extends Unit>(unit: U): unit is U & Occupancy {
    return "occupancy" in unit && "occupancy" in unit.definition;
}

export const initialize: (battle: BattleState, definition: Definition) => Result<State> = (
    battle,
) => {
    return { state: battle, value: { registration: null } };
};
