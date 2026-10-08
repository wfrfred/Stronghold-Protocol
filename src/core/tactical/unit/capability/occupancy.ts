import { createTilePosition, type TilePosition } from "../../geometry/coordinate.js";
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

function cloneOccupancyState(
    state: Readonly<OccupancyState>,
    reuseFrozenPositions: boolean,
): OccupancyState {
    const claims: OccupancyClaim[] = [];

    for (let index = 0; index < state.claims.length; index++) {
        if (!Object.hasOwn(state.claims, index)) {
            throw new TypeError(`missing occupancy claim at index ${index}`);
        }

        const claim = state.claims[index]!;

        claims.push({
            position:
                reuseFrozenPositions && Object.isFrozen(claim.position)
                    ? claim.position
                    : createTilePosition(...claim.position),
            slot: claim.slot,
            type: claim.type,
        });
    }

    return { claims };
}

export function createOccupancyState(state: Readonly<OccupancyState>): OccupancyState {
    return cloneOccupancyState(state, false);
}

export function createOccupancyClaims(
    claims: readonly OccupancyClaim[],
): readonly OccupancyClaim[] {
    return Object.freeze(
        createOccupancyState({ claims }).claims.map((claim) => Object.freeze(claim)),
    );
}

export function copyOccupancyState(state: Readonly<OccupancyState>): OccupancyState {
    return cloneOccupancyState(state, true);
}
