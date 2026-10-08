import * as contribution from "../../../modifier/contribution.js";
import * as modifier from "../../../modifier/value.js";
import { stabilizeUnit, type StableUnit, type Unit, type UnitDefinition } from "../../unit.js";

export interface VitalityDefinition {
    readonly maxHp: number;
}

export interface VitalityState {
    readonly hp: number;
    readonly maxHp: contribution.State<"stored">;
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
    return { ...state, maxHp: contribution.copy(state.maxHp) };
}

export function initializeVitalityState(definition: VitalityDefinition): VitalityState {
    return { hp: definition.maxHp, maxHp: contribution.create<"stored">() };
}

function updateContributions(
    state: VitalityState,
    transition: contribution.Transition<"stored">,
): VitalityState {
    const maxHp = transition(state.maxHp);

    return maxHp === state.maxHp ? state : { ...state, maxHp };
}

export function updateMaxHpContributions<U extends Unit>(
    input: U | StableUnit<U>,
    transition: contribution.Transition<"stored">,
): StableUnit<U> {
    const unit = stabilizeUnit<U>(input);

    if (!hasVitality(unit)) {
        throw new TypeError("maximum HP contributions require Vitality capability");
    }

    const vitality = updateContributions(unit.vitality, transition);

    return vitality === unit.vitality ? unit : { ...unit, vitality };
}

export function resolveVitalityMaxHp(definition: VitalityDefinition, state: VitalityState): number {
    return Math.max(1, modifier.apply(definition.maxHp, contribution.resolve(state.maxHp)));
}
