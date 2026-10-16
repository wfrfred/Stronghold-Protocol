import {
    assertFiniteNumber,
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
    assertPositiveNumber,
} from "../../../../common/assert.js";
import type { State as BattleState } from "../../../battle/state.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";
import * as registry from "../../hook/hook.js";
import * as contribution from "../../contribution/contribution.js";
import type { Value } from "../../contribution/value.js";
import type { Burst, Definition as BurstDefinition } from "./burst.js";
import type { Events, Hook, Key } from "./hook.js";
import type { DamageRequest } from "./operations.js";
import type { Rule } from "./rule.js";

export const ELEMENT_TYPES = Object.freeze(["NEURAL", "EROSION", "BURN", "NECROSIS"] as const);

export type Type = (typeof ELEMENT_TYPES)[number];

export type Values = Readonly<Record<Type, number>>;

export type Input =
    readonly Value[] | ((battle: BattleState, self: Unit & Elemental) => readonly Value[]);

export type DamageInput =
    | readonly Value[]
    | ((battle: BattleState, self: Unit & Elemental, request: DamageRequest) => readonly Value[]);

export interface Definition {
    readonly maxEp: number;
    readonly recoveryPerSecond: number;
    readonly elementResistance: number;
    readonly damageResistance: number;
    readonly burstRecoverySpeed: number;
    readonly bursts: Readonly<Record<Type, BurstDefinition>>;
}

export type Parameter =
    "maxEp" | "recoverySpeed" | "elementResistance" | "damageResistance" | "burstRecoverySpeed";

export interface State {
    readonly ep: Values;
    readonly burst: Burst | null;
    readonly nextBurstId: number;
    readonly lastAdvancedTick: number;
    readonly maxEp: readonly contribution.Contribution<Input>[];
    readonly recoverySpeed: readonly contribution.Contribution<Input>[];
    readonly elementResistance: readonly contribution.Contribution<Input>[];
    readonly damageResistance: readonly contribution.Contribution<Input>[];
    readonly burstRecoverySpeed: readonly contribution.Contribution<Input>[];
    readonly damage: readonly contribution.Contribution<DamageInput>[];
    readonly rules: readonly Rule[];
    readonly received: readonly Hook<Events["received"]>[];
    readonly damaged: readonly Hook<Events["damaged"]>[];
    readonly healed: readonly Hook<Events["healed"]>[];
    readonly burstStarted: readonly Hook<Events["burstStarted"]>[];
    readonly burstEnded: readonly Hook<Events["burstEnded"]>[];
}

export interface Elemental {
    readonly definition: { readonly elemental: Definition };
    readonly elemental: State;
}

export function hasElemental<U extends Unit>(unit: U): unit is U & Elemental {
    return "elemental" in unit && "elemental" in unit.definition;
}

export function hasElementalDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Elemental["definition"] {
    return "elemental" in definition;
}

export function elementValues(value: number): Values {
    return Object.freeze({ NEURAL: value, EROSION: value, BURN: value, NECROSIS: value });
}

export function createDefinition(
    definition: Pick<Definition, "maxEp" | "bursts"> &
        Partial<Omit<Definition, "maxEp" | "bursts">>,
): Definition {
    const {
        maxEp,
        bursts,
        recoveryPerSecond = 0,
        elementResistance = 0,
        damageResistance = 0,
        burstRecoverySpeed = 1,
    } = definition;

    assertPositiveNumber(maxEp, "maximum EP");
    assertNonnegativeNumber(recoveryPerSecond, "EP recovery per second");
    assertFiniteNumber(elementResistance, "element resistance");
    assertFiniteNumber(damageResistance, "element HP damage resistance");
    assertNonnegativeNumber(burstRecoverySpeed, "element burst recovery speed");

    for (const type of ELEMENT_TYPES) {
        assertNonnegativeSafeInteger(bursts[type].durationTicks, "element burst duration");
    }

    return Object.freeze({
        maxEp,
        recoveryPerSecond,
        elementResistance,
        damageResistance,
        burstRecoverySpeed,
        bursts: Object.freeze({ ...bursts }),
    });
}

export function initialize(definition: Definition, tick = 0): State {
    assertNonnegativeSafeInteger(tick, "elemental initialization tick");

    return {
        ep: elementValues(definition.maxEp),
        burst: null,
        nextBurstId: 0,
        lastAdvancedTick: tick,
        maxEp: [],
        recoverySpeed: [],
        elementResistance: [],
        damageResistance: [],
        burstRecoverySpeed: [],
        damage: [],
        rules: [],
        received: [],
        damaged: [],
        healed: [],
        burstStarted: [],
        burstEnded: [],
    };
}

export function setContribution(
    state: State,
    key: Parameter,
    entry: contribution.Contribution<Input>,
): State {
    const entries = contribution.set(state[key], entry);

    return entries === state[key] ? state : { ...state, [key]: entries };
}

export function removeContribution(state: State, key: Parameter, id: string): State {
    const entries = contribution.remove(state[key], id);

    return entries === state[key] ? state : { ...state, [key]: entries };
}

export function setDamageContribution(
    state: State,
    entry: contribution.Contribution<DamageInput>,
): State {
    const damage = contribution.set(state.damage, entry);

    return damage === state.damage ? state : { ...state, damage };
}

export function removeDamageContribution(state: State, id: string): State {
    const damage = contribution.remove(state.damage, id);

    return damage === state.damage ? state : { ...state, damage };
}

export function setRule(state: State, rule: Rule): State {
    const rules = registry.set(state.rules, rule);

    return rules === state.rules ? state : { ...state, rules };
}

export function removeRule(state: State, id: string): State {
    const rules = registry.remove(state.rules, id);

    return rules === state.rules ? state : { ...state, rules };
}

export function setHook<K extends Key>(state: State, key: K, hook: Hook<Events[K]>): State {
    const hooks = registry.set(state[key] as readonly Hook<Events[K]>[], hook);

    return hooks === state[key] ? state : { ...state, [key]: hooks };
}

export function removeHook(state: State, key: Key, id: string): State {
    const hooks = state[key].filter((hook) => hook.id !== id);

    return hooks.length === state[key].length ? state : { ...state, [key]: hooks };
}
