import { createShapeGeometry, type HitGeometry } from "../../../geometry/shape.js";
import type { Unit } from "../../unit.js";

export type SpatialLayer = "GROUND" | "AIR";

export interface SpatialDefinition {
    readonly layer: SpatialLayer;
}

export type SpatialState = SpatialDefinition;

export interface Spatial {
    readonly definition: { readonly spatial: SpatialDefinition };
    readonly spatial: SpatialState;
}

export interface HitDefinition {
    readonly geometry: HitGeometry;
}

export type HitState = HitDefinition;

export interface Hit {
    readonly definition: { readonly hit: HitDefinition };
    readonly hit: HitState;
}

export function hasSpatial<U extends Unit>(unit: U): unit is U & Spatial {
    return "spatial" in unit && "spatial" in unit.definition;
}

export function hasHit<U extends Unit>(unit: U): unit is U & Hit {
    return "hit" in unit && "hit" in unit.definition;
}

export function createHitDefinition(definition: HitDefinition): HitDefinition {
    return Object.freeze({ geometry: createShapeGeometry(definition.geometry) });
}

export function initializeSpatialState(definition: SpatialDefinition): SpatialState {
    return { layer: definition.layer };
}

export function initializeHitState(definition: HitDefinition): HitState {
    return { geometry: definition.geometry };
}
