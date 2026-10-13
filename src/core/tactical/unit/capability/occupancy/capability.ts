import { assertSafeInteger } from "../../../../common/assert.js";
import type { TilePosition } from "../../../geometry/coordinate.js";
import type { Unit } from "../../unit.js";
import { isSpatiallyPresent } from "../presence/capability.js";

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
    readonly occupancy: State;
}

export function hasOccupancy<U extends Unit>(unit: U): unit is U & Occupancy {
    return "occupancy" in unit;
}

export function isOccupancyClaimActive(unit: Unit, claim: OccupancyClaim): boolean {
    return claim.type === "RESERVATION" || isSpatiallyPresent(unit);
}

export function validateState(state: State): void {
    for (const claim of state.claims) {
        assertSafeInteger(claim.position[0], "occupancy row");
        assertSafeInteger(claim.position[1], "occupancy column");
    }
}
