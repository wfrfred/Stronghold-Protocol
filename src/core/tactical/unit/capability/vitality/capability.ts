import { preserveHpRatio } from "./max-hp.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";
import type { Hook as DamageHook } from "./damage/hook.js";
import type { Hook as HealingHook } from "./healing/hook.js";

export interface Definition {
    readonly maxHp: number;
}

export interface State {
    readonly hp: number;
    readonly maxHp: readonly contribution.Contribution[];
    readonly damageHooks: readonly DamageHook[];
    readonly healingHooks: readonly HealingHook[];
}

export interface Vitality {
    readonly definition: {
        readonly vitality: Definition;
    };
    readonly vitality: State;
}

export function hasVitality<U extends Unit>(unit: U): unit is U & Vitality {
    return "vitality" in unit && "vitality" in unit.definition;
}

export function hasVitalityDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Vitality["definition"] {
    return "vitality" in definition;
}

export function initialize(definition: Definition): State {
    return { hp: definition.maxHp, maxHp: [], damageHooks: [], healingHooks: [] };
}

function changeMaxHpContributions(
    definition: Definition,
    state: State,
    transition: (
        entries: readonly contribution.Contribution[],
    ) => readonly contribution.Contribution[],
): State {
    const maxHp = transition(state.maxHp);

    return maxHp === state.maxHp ? state : preserveHpRatio(definition, state, { ...state, maxHp });
}

export function setMaxHpContribution(
    definition: Definition,
    state: State,
    entry: contribution.Contribution,
): State {
    return changeMaxHpContributions(definition, state, (entries) =>
        contribution.set(entries, entry),
    );
}

export function removeMaxHpContribution(definition: Definition, state: State, id: string): State {
    return changeMaxHpContributions(definition, state, (entries) =>
        contribution.remove(entries, id),
    );
}

export function resolveMaxHp(definition: Definition, state: State): number {
    return Math.max(1, modifier.apply(definition.maxHp, contribution.resolve(state.maxHp)));
}
