import type { State as BattleState, Result } from "../../../battle/state.js";
import { preserveHpRatio } from "./max-hp.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";
import type { Hook as DamageHook } from "./damage/hook.js";
import type { Hook as HealingHook } from "./healing/hook.js";
import type { Rule as DamageReceptionRule } from "./damage/reception.js";
import type { Rule as FatalProtectionRule } from "./damage/fatal-protection.js";
import type { Rule as HealingReceptionRule } from "./healing/reception.js";
import * as registry from "../../hook/hook.js";

export interface Definition {
    readonly maxHp: number;
}

export interface State {
    readonly hp: number;
    readonly maxHp: readonly contribution.Contribution[];
    readonly damageHooks: readonly DamageHook[];
    readonly healingHooks: readonly HealingHook[];
    readonly damageReceptionRules: readonly DamageReceptionRule[];
    readonly fatalProtectionRules: readonly FatalProtectionRule[];
    readonly healingReceptionRules: readonly HealingReceptionRule[];
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

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    return {
        state: battle,
        value: {
            hp: definition.maxHp,
            maxHp: [],
            damageHooks: [],
            healingHooks: [],
            damageReceptionRules: [],
            fatalProtectionRules: [],
            healingReceptionRules: [],
        },
    };
}

export function setDamageReceptionRule(state: State, rule: DamageReceptionRule): State {
    const damageReceptionRules = registry.set(state.damageReceptionRules, rule);

    return damageReceptionRules === state.damageReceptionRules
        ? state
        : { ...state, damageReceptionRules };
}

export function removeDamageReceptionRule(state: State, id: string): State {
    const damageReceptionRules = registry.remove(state.damageReceptionRules, id);

    return damageReceptionRules === state.damageReceptionRules
        ? state
        : { ...state, damageReceptionRules };
}

export function setFatalProtectionRule(state: State, rule: FatalProtectionRule): State {
    const fatalProtectionRules = registry.set(state.fatalProtectionRules, rule);

    return fatalProtectionRules === state.fatalProtectionRules
        ? state
        : { ...state, fatalProtectionRules };
}

export function removeFatalProtectionRule(state: State, id: string): State {
    const fatalProtectionRules = registry.remove(state.fatalProtectionRules, id);

    return fatalProtectionRules === state.fatalProtectionRules
        ? state
        : { ...state, fatalProtectionRules };
}

export function setHealingReceptionRule(state: State, rule: HealingReceptionRule): State {
    const healingReceptionRules = registry.set(state.healingReceptionRules, rule);

    return healingReceptionRules === state.healingReceptionRules
        ? state
        : { ...state, healingReceptionRules };
}

export function removeHealingReceptionRule(state: State, id: string): State {
    const healingReceptionRules = registry.remove(state.healingReceptionRules, id);

    return healingReceptionRules === state.healingReceptionRules
        ? state
        : { ...state, healingReceptionRules };
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
