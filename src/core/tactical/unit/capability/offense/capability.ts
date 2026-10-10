import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as contribution from "../../../contribution/state.js";
import * as modifier from "../../../contribution/value.js";
import { widenUnit, type StableUnit, type Unit, type UnitDefinition } from "../../unit.js";

export interface OffenseDefinition {
    readonly attack: number;
}

export interface OffenseState {
    readonly attack: contribution.State;
}

export interface Offense {
    readonly offense: OffenseState;
}

export interface OffensiveUnitDefinition extends UnitDefinition {
    readonly offense: OffenseDefinition;
}

export function hasOffense<U extends Unit>(
    unit: U,
): unit is U & Offense & Unit<U["definition"] & OffensiveUnitDefinition> {
    return "offense" in unit && "offense" in unit.definition;
}

export function hasOffenseDefinition(
    definition: UnitDefinition,
): definition is OffensiveUnitDefinition {
    return "offense" in definition;
}

export function createOffenseDefinition(definition: OffenseDefinition): OffenseDefinition {
    assertNonnegativeNumber(definition.attack, "attack");

    return Object.freeze({ attack: definition.attack });
}

export function initializeOffenseState(definition?: OffenseDefinition): OffenseState;
export function initializeOffenseState(): OffenseState {
    return { attack: contribution.empty() };
}

function updateContributions(
    state: OffenseState,
    transition: contribution.Transition,
): OffenseState {
    const attack = transition(state.attack);

    return attack === state.attack ? state : { ...state, attack };
}

export function updateAttackContributions<U extends Unit>(
    input: U | StableUnit<U>,
    transition: contribution.Transition,
): StableUnit<U> {
    const unit = widenUnit<U>(input);

    if (!hasOffense(unit)) {
        throw new TypeError("attack contributions require Offense capability");
    }

    const offense = updateContributions(unit.offense, transition);

    return offense === unit.offense ? unit : { ...unit, offense };
}

export function resolveOffenseAttack(
    definition: OffenseDefinition,
    state: OffenseState,
    evaluate?: contribution.Evaluate,
): number {
    return Math.max(
        0,
        modifier.apply(definition.attack, contribution.resolve(state.attack, evaluate)),
    );
}
