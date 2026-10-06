import type { Unit, UnitDefinition } from "../unit.js";

export interface TargetableState {
    readonly layer: "GROUND" | "AIR";
    readonly enabled: boolean;
}

export interface Targetable {
    readonly targetable: TargetableState;
}

export interface TargetableUnitDefinition extends UnitDefinition {
    readonly targetable: TargetableState;
}

export function hasTargetable<U extends Unit>(
    unit: U,
): unit is U & Targetable & Unit<U["definition"] & TargetableUnitDefinition> {
    return "targetable" in unit && "targetable" in unit.definition;
}

export function createTargetableState(state: TargetableState): TargetableState {
    const layer: unknown = state.layer;

    if (layer !== "GROUND" && layer !== "AIR") {
        throw new TypeError("target layer must be GROUND or AIR");
    }
    if (typeof state.enabled !== "boolean") {
        throw new TypeError("target eligibility must be boolean");
    }

    return Object.freeze({ ...state });
}

export function copyTargetableState(state: TargetableState): TargetableState {
    return { ...state };
}

export function initializeTargetableState(definition: TargetableState): TargetableState {
    return copyTargetableState(definition);
}
