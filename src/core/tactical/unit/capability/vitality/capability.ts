import type { State as BattleState, Result } from "../../../battle/state.js";
import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as contribution from "../../contribution/contribution.js";
import * as attribute from "../../contribution/attribute.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";
import type { Context } from "../../query.js";
import type {
    Hook as DamageHook,
    ReceptionRule as DamageReceptionRule,
} from "../../../battle/damage/hook.js";
import type { Hook as HealingHook } from "../../../battle/healing/hook.js";
import * as registry from "../../hook/hook.js";

export interface Definition {
    readonly maxHp: number;
    readonly defense: number;
    readonly resistance: number;
}

export interface DefenseValues {
    readonly defense: number;
    readonly resistance: number;
}

export interface State {
    readonly hp: number;
    readonly maxHp: readonly contribution.Contribution<readonly attribute.Modifier[]>[];
    readonly defense: readonly contribution.Contribution<attribute.Input<Context>>[];
    readonly resistance: readonly contribution.Contribution<attribute.Input<Context>>[];
    readonly damageHooks: readonly DamageHook[];
    readonly healingHooks: readonly HealingHook[];
    readonly damageReceptionRules: readonly DamageReceptionRule[];
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
    assertNonnegativeNumber(definition.maxHp, "maxHp");
    assertNonnegativeNumber(definition.defense, "defense");
    assertNonnegativeNumber(definition.resistance, "resistance");

    return {
        state: battle,
        value: {
            hp: Math.max(1, definition.maxHp),
            maxHp: [],
            defense: [],
            resistance: [],
            damageHooks: [],
            healingHooks: [],
            damageReceptionRules: [],
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

function changeMaxHpContributions(
    state: State,
    definition: Definition,
    transition: (
        entries: readonly contribution.Contribution<readonly attribute.Modifier[]>[],
    ) => readonly contribution.Contribution<readonly attribute.Modifier[]>[],
): State {
    const maxHp = transition(state.maxHp);

    if (maxHp === state.maxHp) {
        return state;
    }

    const next = { ...state, maxHp };
    const previousMax = resolveMaxHp(state, definition);
    const nextMax = resolveMaxHp(next, definition);

    if (previousMax === nextMax || state.hp <= 0) {
        return next;
    }

    return { ...next, hp: Math.min(nextMax, (state.hp / previousMax) * nextMax) };
}

export function setMaxHpContribution(
    state: State,
    definition: Definition,
    entry: contribution.Contribution<readonly attribute.Modifier[]>,
): State {
    return changeMaxHpContributions(state, definition, (entries) =>
        contribution.set(entries, entry),
    );
}

export function removeMaxHpContribution(state: State, definition: Definition, id: string): State {
    return changeMaxHpContributions(state, definition, (entries) =>
        contribution.remove(entries, id),
    );
}

export function resolveMaxHp(state: State, definition: Definition): number {
    return Math.max(1, attribute.apply(definition.maxHp, contribution.resolve(state.maxHp).flat()));
}

function updateContributions(
    state: State,
    parameter: "defense" | "resistance",
    transition: (entries: State["defense"]) => State["defense"],
): State {
    const current = state[parameter];
    const updated = transition(current);

    return updated === current ? state : { ...state, [parameter]: updated };
}

export function setDefenseContribution(
    state: State,
    entry: contribution.Contribution<attribute.Input<Context>>,
): State {
    return updateContributions(state, "defense", (entries) => contribution.set(entries, entry));
}

export function removeDefenseContribution(state: State, id: string): State {
    return updateContributions(state, "defense", (entries) => contribution.remove(entries, id));
}

export function setResistanceContribution(
    state: State,
    entry: contribution.Contribution<attribute.Input<Context>>,
): State {
    return updateContributions(state, "resistance", (entries) => contribution.set(entries, entry));
}

export function removeResistanceContribution(state: State, id: string): State {
    return updateContributions(state, "resistance", (entries) => contribution.remove(entries, id));
}

export function resolveDefense(
    state: State,
    definition: Definition,
    context: Context,
): DefenseValues {
    return {
        defense: Math.max(
            0,
            attribute.apply(
                definition.defense,
                contribution
                    .resolve(state.defense)
                    .flatMap((value) => attribute.evaluate(value, context)),
            ),
        ),
        resistance: Math.min(
            100,
            Math.max(
                0,
                attribute.apply(
                    definition.resistance,
                    contribution
                        .resolve(state.resistance)
                        .flatMap((value) => attribute.evaluate(value, context)),
                ),
            ),
        ),
    };
}
