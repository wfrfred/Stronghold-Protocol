import { createShapeGeometry, type HitGeometry } from "../../geometry/shape.js";
import type { Unit, UnitDefinition } from "../unit.js";

export type SpatialLayer = "GROUND" | "AIR";

export interface SpatialDefinition {
    readonly layer: SpatialLayer;
}

export type SpatialState = SpatialDefinition;

export interface Spatial {
    readonly spatial: SpatialState;
}

export interface SpatialUnitDefinition extends UnitDefinition {
    readonly spatial: SpatialDefinition;
}

export interface HitDefinition {
    readonly geometry: HitGeometry;
}

export type HitState = HitDefinition;

export interface Hit {
    readonly hit: HitState;
}

export interface HitUnitDefinition extends UnitDefinition {
    readonly hit: HitDefinition;
}

export function hasSpatial<U extends Unit>(
    unit: U,
): unit is U & Spatial & Unit<U["definition"] & SpatialUnitDefinition> {
    return "spatial" in unit && "spatial" in unit.definition;
}

export function hasHit<U extends Unit>(
    unit: U,
): unit is U & Hit & Unit<U["definition"] & HitUnitDefinition> {
    return "hit" in unit && "hit" in unit.definition;
}

export function createSpatialDefinition(definition: SpatialDefinition): SpatialDefinition {
    return Object.freeze({ layer: definition.layer });
}

export function createHitDefinition(definition: HitDefinition): HitDefinition {
    return Object.freeze({ geometry: createShapeGeometry(definition.geometry) });
}

export function copySpatialState(state: SpatialState): SpatialState {
    return { ...state };
}

export function copyHitState(state: HitState): HitState {
    return { geometry: createShapeGeometry(state.geometry) };
}

export function initializeSpatialState(definition: SpatialDefinition): SpatialState {
    return copySpatialState(definition);
}

export function initializeHitState(definition: HitDefinition): HitState {
    return copyHitState(definition);
}
