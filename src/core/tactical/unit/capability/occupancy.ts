import {
    createTilePosition,
    isTilePosition,
    type TilePosition,
} from "../../geometry/coordinate.js";
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
    const claimsAreArray: boolean = Array.isArray(state.claims);

    if (!claimsAreArray) {
        throw new TypeError("occupancy claims must be an array");
    }

    const claims: OccupancyClaim[] = [];

    for (let index = 0; index < state.claims.length; index++) {
        const input: unknown = state.claims[index];

        if (!Object.hasOwn(state.claims, index) || input === undefined || input === null) {
            throw new TypeError(`missing occupancy claim at index ${index}`);
        }
        if (typeof input !== "object" || Array.isArray(input)) {
            throw new TypeError(`invalid occupancy claim at index ${index}`);
        }

        const claim = input as OccupancyClaim;

        if (!isTilePosition(claim.position)) {
            throw new RangeError(`invalid occupancy position at index ${index}`);
        }

        const slot: unknown = claim.slot;
        const type: unknown = claim.type;

        if (slot !== "DEPLOYMENT" && slot !== "SUPPORT") {
            throw new TypeError(`invalid occupancy slot at index ${index}`);
        }
        if (type !== "PRESENT" && type !== "RESERVATION") {
            throw new TypeError(`invalid occupancy type at index ${index}`);
        }

        claims.push({
            position:
                reuseFrozenPositions && Object.isFrozen(claim.position)
                    ? claim.position
                    : createTilePosition(...claim.position),
            slot,
            type,
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
