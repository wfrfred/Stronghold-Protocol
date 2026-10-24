import type { State as BattleState, Result } from "../../../battle/state.js";
import { assertPositiveSafeInteger, assertSafeInteger } from "../../../../common/assert.js";
import * as registry from "../../hook/hook.js";
import * as contribution from "../../contribution/contribution.js";
import type { Unit } from "../../unit.js";
import type { Ref } from "../../../../common/ref.js";
import type { Blocker } from "./blocker.js";
import type { Hook, Key } from "../../../battle/blocking/hook.js";

export interface Definition {
    readonly volume: number;
}

export interface Rule {
    readonly id: string;
    readonly allows: (unit: Unit & Blockable) => boolean;
}

export interface State {
    readonly blocker: Ref<Unit & Blocker> | null;
    readonly volume: readonly contribution.Contribution<number>[];
    readonly rules: readonly Rule[];
    readonly acquired: readonly Hook<Unit & Blockable>[];
    readonly released: readonly Hook<Unit & Blockable>[];
}

export interface Blockable {
    readonly definition: {
        readonly blockable: Definition;
    };
    readonly blockable: State;
}

export function hasBlockable<U extends Unit>(unit: U): unit is U & Blockable {
    return "blockable" in unit && "blockable" in unit.definition;
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    assertPositiveSafeInteger(definition.volume, "blocking volume");

    return {
        state: battle,
        value: { blocker: null, volume: [], rules: [], acquired: [], released: [] },
    };
}

export function setHook(state: State, key: Key, hook: Hook<Unit & Blockable>): State {
    const entries = registry.set(state[key], hook);

    return entries === state[key] ? state : { ...state, [key]: entries };
}

export function removeHook(state: State, key: Key, id: string): State {
    const entries = registry.remove(state[key], id);

    return entries === state[key] ? state : { ...state, [key]: entries };
}

export function setRule(state: State, rule: Rule): State {
    const rules = registry.set(state.rules, rule);

    return rules === state.rules ? state : { ...state, rules };
}

export function removeRule(state: State, id: string): State {
    const rules = registry.remove(state.rules, id);

    return rules === state.rules ? state : { ...state, rules };
}

export function canBeBlocked(unit: Unit & Blockable): boolean {
    return unit.blockable.rules.every((rule) => rule.allows(unit));
}

export function setVolumeContribution(
    state: State,
    entry: contribution.Contribution<number>,
): State {
    assertSafeInteger(entry.value, "blocking volume addition");

    const volume = contribution.set(state.volume, entry);

    return volume === state.volume ? state : { ...state, volume };
}

export function removeVolumeContribution(state: State, id: string): State {
    const volume = contribution.remove(state.volume, id);

    return volume === state.volume ? state : { ...state, volume };
}

export function resolveVolume(definition: Definition, state: State): number {
    return Math.max(
        1,
        contribution
            .resolve(state.volume)
            .reduce((volume, addition) => volume + addition, definition.volume),
    );
}
