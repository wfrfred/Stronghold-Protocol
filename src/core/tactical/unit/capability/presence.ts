import type { Unit } from "../unit.js";

export interface SpatialPresenceState {
    readonly present: boolean;
}

export interface SpatialPresence {
    readonly spatialPresence: SpatialPresenceState;
}

export function hasSpatialPresence(unit: Unit): unit is Unit & SpatialPresence {
    return "spatialPresence" in unit;
}

export function isSpatiallyPresent(unit: Unit): boolean {
    return !hasSpatialPresence(unit) || unit.spatialPresence.present;
}
