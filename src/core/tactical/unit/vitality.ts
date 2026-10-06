import type { Unit, UnitDefinition } from "./unit.js";

export interface VitalityDefinition {
    readonly maxHp: number;
}

export interface VitalityState {
    hp: number;
}

export interface Vitality {
    readonly vitality: VitalityState;
}

export interface VitalUnitDefinition extends UnitDefinition {
    readonly vitality: VitalityDefinition;
}

export type VitalUnit<D extends VitalUnitDefinition = VitalUnitDefinition> =
    Unit<D> & Vitality;

export function hasVitality(unit: Unit): unit is Unit & Vitality {
    return "vitality" in unit;
}

export function hasVitalityDefinition(definition: UnitDefinition): definition is VitalUnitDefinition {
    return "vitality" in definition;
}

export function copyVitalityState(state: Readonly<VitalityState>): VitalityState {
    return { ...state };
}
