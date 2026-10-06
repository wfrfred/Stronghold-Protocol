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

export function hasTargetable(unit: Unit): unit is Unit & Targetable {
    return "targetable" in unit;
}

export function hasTargetableDefinition(
    definition: UnitDefinition,
): definition is TargetableUnitDefinition {
    return "targetable" in definition;
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
