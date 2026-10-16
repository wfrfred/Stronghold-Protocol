import type { Context } from "../../query.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";
import type { Id as DefinitionId } from "../../action/definition.js";
import type { Definitions } from "../../action/definitions.js";
import type { State as CooldownState } from "../../action/cooldown.js";
import * as contribution from "../../contribution/contribution.js";
import * as hook from "../../hook/hook.js";
import type { Hook as ReleaseHook, ReleasedHook } from "./release.js";

export interface Definition {
    readonly definitions: Definitions;
    readonly select?: (battle: BattleState, self: Unit & Action) => Result<readonly DefinitionId[]>;
}

export interface Rule {
    readonly id: string;
    readonly allows: (
        battle: BattleState,
        self: Unit & Action,
        definitionId: DefinitionId,
    ) => boolean;
}

export interface State {
    readonly cooldowns: ReadonlyMap<DefinitionId, CooldownState>;
    readonly interval: readonly contribution.Contribution<contribution.Input<Context>>[];
    readonly speed: readonly contribution.Contribution<contribution.Input<Context>>[];
    readonly rules: readonly Rule[];
    readonly beforeRelease: readonly ReleaseHook[];
    readonly released: readonly ReleasedHook[];
}

export interface Action {
    readonly definition: { readonly action: Definition };
    readonly action: State;
}

export function hasAction<U extends Unit>(unit: U): unit is U & Action {
    return "action" in unit && "action" in unit.definition;
}

export function hasActionDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Action["definition"] {
    return "action" in definition;
}

export function createDefinition(definition: Definition): Definition {
    return Object.freeze({ ...definition });
}

export const initialize: (battle: BattleState, definition: Definition) => Result<State> = (
    battle,
) => {
    return {
        state: battle,
        value: {
            cooldowns: new Map(),
            interval: [],
            speed: [],
            rules: [],
            beforeRelease: [],
            released: [],
        },
    };
};

export function setRule(state: State, rule: Rule): State {
    const rules = hook.set(state.rules, rule);

    return rules === state.rules ? state : { ...state, rules };
}

export function removeRule(state: State, id: string): State {
    const rules = hook.remove(state.rules, id);

    return rules === state.rules ? state : { ...state, rules };
}

export function setBeforeReleaseHook(state: State, entry: ReleaseHook): State {
    const beforeRelease = hook.set(state.beforeRelease, entry);

    return beforeRelease === state.beforeRelease ? state : { ...state, beforeRelease };
}

export function removeBeforeReleaseHook(state: State, id: string): State {
    const beforeRelease = hook.remove(state.beforeRelease, id);

    return beforeRelease === state.beforeRelease ? state : { ...state, beforeRelease };
}

export function setReleasedHook(state: State, entry: ReleasedHook): State {
    const released = hook.set(state.released, entry);

    return released === state.released ? state : { ...state, released };
}

export function removeReleasedHook(state: State, id: string): State {
    const released = hook.remove(state.released, id);

    return released === state.released ? state : { ...state, released };
}

function updateContributions(
    state: State,
    key: "interval" | "speed",
    transition: (entries: State["interval"]) => State["interval"],
): State {
    const updated = transition(state[key]);

    return updated === state[key] ? state : { ...state, [key]: updated };
}

export function setIntervalContribution(
    state: State,
    entry: contribution.Contribution<contribution.Input<Context>>,
): State {
    return updateContributions(state, "interval", (entries) => contribution.set(entries, entry));
}

export function removeIntervalContribution(state: State, id: string): State {
    return updateContributions(state, "interval", (entries) => contribution.remove(entries, id));
}

export function setSpeedContribution(
    state: State,
    entry: contribution.Contribution<contribution.Input<Context>>,
): State {
    return updateContributions(state, "speed", (entries) => contribution.set(entries, entry));
}

export function removeSpeedContribution(state: State, id: string): State {
    return updateContributions(state, "speed", (entries) => contribution.remove(entries, id));
}
