import { assertSafeInteger } from "../../../common/assert.js";
import type { TilePosition } from "../../geometry/coordinate.js";
import type { Unit } from "../unit.js";
import { isSpatiallyPresent } from "./presence.js";

export type OccupancySlot = "DEPLOYMENT" | "SUPPORT";

export interface OccupancyClaim {
    readonly position: TilePosition;
    readonly slot: OccupancySlot;
    readonly type: "PRESENT" | "RESERVATION";
}

export interface OccupancyState {
    readonly claims: readonly OccupancyClaim[];
}

export interface Occupancy {
    readonly occupancy: OccupancyState;
}

export function hasOccupancy<U extends Unit>(unit: U): unit is U & Occupancy {
    return "occupancy" in unit;
}

export function isOccupancyClaimActive(unit: Unit, claim: OccupancyClaim): boolean {
    return claim.type === "RESERVATION" || isSpatiallyPresent(unit);
}

export function createOccupancyState(state: Readonly<OccupancyState>): OccupancyState {
    for (const claim of state.claims) {
        assertSafeInteger(claim.position[0], "occupancy row");
        assertSafeInteger(claim.position[1], "occupancy column");
    }

    return state;
}

export function createOccupancyClaims(
    claims: readonly OccupancyClaim[],
): readonly OccupancyClaim[] {
    return createOccupancyState({ claims }).claims;
}
