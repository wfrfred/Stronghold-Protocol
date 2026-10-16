import type { State as BattleState, Result } from "../../../battle/state.js";
import { preserveHpRatio } from "./max-hp.js";
import * as contribution from "../../contribution/contribution.js";
import * as attribute from "../../contribution/attribute.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";
import type {
    Hook as DamageHook,
    ReceptionRule as DamageReceptionRule,
} from "../../../battle/damage/hook.js";
import type { Hook as HealingHook } from "./healing/hook.js";
import type { Rule as HealingReceptionRule } from "./healing/reception.js";
import * as registry from "../../hook/hook.js";

export interface Definition {
    readonly maxHp: number;
}

export interface State {
    readonly hp: number;
    readonly maxHp: readonly contribution.Contribution<readonly attribute.Modifier[]>[];
    readonly damageHooks: readonly DamageHook[];
    readonly healingHooks: readonly HealingHook[];
    readonly damageReceptionRules: readonly DamageReceptionRule[];
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
        entries: readonly contribution.Contribution<readonly attribute.Modifier[]>[],
    ) => readonly contribution.Contribution<readonly attribute.Modifier[]>[],
): State {
    const maxHp = transition(state.maxHp);

    return maxHp === state.maxHp ? state : preserveHpRatio(definition, state, { ...state, maxHp });
}

export function setMaxHpContribution(
    definition: Definition,
    state: State,
    entry: contribution.Contribution<readonly attribute.Modifier[]>,
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
    return Math.max(1, attribute.apply(definition.maxHp, contribution.resolve(state.maxHp).flat()));
}
