import type { Unit, UnitDefinition } from "../unit.js";

export interface VitalityDefinition {
    readonly maxHp: number;
}

export interface VitalityState {
    readonly hp: number;
}

export interface Vitality {
    readonly vitality: VitalityState;
}

export interface VitalUnitDefinition extends UnitDefinition {
    readonly vitality: VitalityDefinition;
}

export type VitalUnit<D extends VitalUnitDefinition = VitalUnitDefinition> = Unit<D> & Vitality;

export function hasVitality<U extends Unit>(
    unit: U,
): unit is U & VitalUnit<U["definition"] & VitalUnitDefinition> {
    return "vitality" in unit && "vitality" in unit.definition;
}

export function hasVitalityDefinition(
    definition: UnitDefinition,
): definition is VitalUnitDefinition {
    return "vitality" in definition;
}

export function copyVitalityState(state: Readonly<VitalityState>): VitalityState {
    return { ...state };
}

export function initializeVitalityState(definition: VitalityDefinition): VitalityState {
    return { hp: definition.maxHp };
}
