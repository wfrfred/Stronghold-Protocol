import type { QueryContext } from "../../query.js";
import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as contribution from "../../../contribution/contribution.js";
import * as modifier from "../../../contribution/value.js";
import { widenUnit, type StableUnit, type Unit, type UnitDefinition } from "../../unit.js";

export interface OffenseDefinition {
    readonly attack: number;
}

export interface OffenseState {
    readonly attack: readonly contribution.Contribution<contribution.Input<QueryContext>>[];
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
    return { attack: [] };
}

function changeAttackContributions<U extends Unit>(
    input: U | StableUnit<U>,
    transition: (entries: OffenseState["attack"]) => OffenseState["attack"],
): StableUnit<U> {
    const unit = widenUnit<U>(input);

    if (!hasOffense(unit)) {
        throw new TypeError("attack contributions require Offense capability");
    }

    const attack = transition(unit.offense.attack);

    return attack === unit.offense.attack
        ? unit
        : { ...unit, offense: { ...unit.offense, attack } };
}

export function setAttackContribution<U extends Unit>(
    unit: U | StableUnit<U>,
    entry: contribution.Contribution<contribution.Input<QueryContext>>,
): StableUnit<U> {
    return changeAttackContributions<U>(unit, (entries) => contribution.set(entries, entry));
}

export function removeAttackContribution<U extends Unit>(
    unit: U | StableUnit<U>,
    id: string,
): StableUnit<U> {
    return changeAttackContributions<U>(unit, (entries) => contribution.remove(entries, id));
}

export function resolveOffenseAttack(
    definition: OffenseDefinition,
    state: OffenseState,
    context: QueryContext,
): number {
    return Math.max(
        0,
        modifier.apply(
            definition.attack,
            contribution.resolve(state.attack, (value) => contribution.evaluate(value, context)),
        ),
    );
}
