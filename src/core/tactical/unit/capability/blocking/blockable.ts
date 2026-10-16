import type { State as BattleState, Result } from "../../../battle/state.js";
import { assertPositiveSafeInteger } from "../../../../common/assert.js";
import * as registry from "../../hook/hook.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import type { Unit } from "../../unit.js";

export interface Definition {
    readonly volume: number;
}

export interface Rule {
    readonly id: string;
    readonly allows: (unit: Unit & Blockable) => boolean;
}

export interface State {
    readonly volume: readonly contribution.Contribution[];
    readonly rules: readonly Rule[];
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

    return { state: battle, value: { volume: [], rules: [] } };
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

export function setVolumeContribution(state: State, entry: contribution.Contribution): State {
    const volume = contribution.set(state.volume, entry);

    return volume === state.volume ? state : { ...state, volume };
}

export function removeVolumeContribution(state: State, id: string): State {
    const volume = contribution.remove(state.volume, id);

    return volume === state.volume ? state : { ...state, volume };
}

export function resolveVolume(definition: Definition, state: State): number {
    const value = Math.max(
        0,
        modifier.apply(definition.volume, contribution.resolve(state.volume)),
    );
    const lower = Math.floor(value);

    return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value);
}
