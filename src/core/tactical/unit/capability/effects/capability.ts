import type { EffectInstanceValue } from "./instance.js";
import type { Unit } from "../../unit.js";

export interface EffectsState {
    readonly instances: readonly EffectInstanceValue[];
    readonly nextInstanceId: number;
    readonly nextAcquiredSequence: number;
}

export interface Effects {
    readonly effects: EffectsState;
}

export function hasEffects<U extends Unit>(unit: U): unit is U & Effects {
    return "effects" in unit;
}
