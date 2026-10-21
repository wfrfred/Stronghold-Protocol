import { createShapeGeometry, type HitGeometry } from "../../../geometry/shape.js";
import type { Unit } from "../../unit.js";
import type { State as BattleState, Result } from "../../../battle/state.js";

export interface HitDefinition {
    readonly geometry: HitGeometry;
}

export type HitState = HitDefinition;

export interface Hit {
    readonly definition: { readonly hit: HitDefinition };
    readonly hit: HitState;
}

export function hasHit<U extends Unit>(unit: U): unit is U & Hit {
    return "hit" in unit && "hit" in unit.definition;
}

export function createHitDefinition(definition: HitDefinition): HitDefinition {
    return Object.freeze({ geometry: createShapeGeometry(definition.geometry) });
}

export function initializeHitState(
    battle: BattleState,
    definition: HitDefinition,
): Result<HitState> {
    return { state: battle, value: { geometry: definition.geometry } };
}
