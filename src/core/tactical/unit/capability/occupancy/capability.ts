import { assertSafeInteger } from "../../../../common/assert.js";
import type { TilePosition } from "../../../geometry/coordinate.js";
import type { Unit } from "../../unit.js";
import { isSpatiallyPresent } from "../presence/capability.js";
import type { State as BattleState, Result } from "../../../battle/state.js";

export type Definition = Readonly<Record<string, never>>;

export type OccupancySlot = "DEPLOYMENT" | "SUPPORT";

export interface OccupancyClaim {
    readonly position: TilePosition;
    readonly slot: OccupancySlot;
    readonly type: "PRESENT" | "RESERVATION";
}

export interface State {
    readonly claims: readonly OccupancyClaim[];
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
    return { state: battle, value: { claims: [] } };
};

export function isOccupancyClaimActive(unit: Unit, claim: OccupancyClaim): boolean {
    return claim.type === "RESERVATION" || isSpatiallyPresent(unit);
}

export function validateState(state: State): void {
    for (const claim of state.claims) {
        assertSafeInteger(claim.position[0], "occupancy row");
        assertSafeInteger(claim.position[1], "occupancy column");
    }
}
