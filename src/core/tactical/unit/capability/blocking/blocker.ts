import type { State as BattleState, Result } from "../../../battle/state.js";
import * as registry from "../../hook/hook.js";
import {
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
} from "../../../../common/assert.js";
import type { BlockGeometry } from "../../../geometry/shape.js";
import * as contribution from "../../contribution/contribution.js";
import * as attribute from "../../contribution/attribute.js";
import type { Unit } from "../../unit.js";

export interface Definition {
    readonly capacity: number;
    readonly geometry: BlockGeometry;
}

export interface Rule {
    readonly id: string;
    readonly allows: (unit: Unit & Blocker) => boolean;
}

export interface State {
    readonly capacity: readonly contribution.Contribution<readonly attribute.Modifier[]>[];
    readonly geometry: BlockGeometry;
    readonly rules: readonly Rule[];
}

export interface Blocker {
    readonly definition: {
        readonly blocker: Definition;
    };
    readonly blocker: State;
}

export function hasBlocker<U extends Unit>(unit: U): unit is U & Blocker {
    return "blocker" in unit && "blocker" in unit.definition;
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    assertNonnegativeSafeInteger(definition.capacity, "blocking capacity");
    assertNonnegativeNumber(definition.geometry.radius, "block radius");

    return {
        state: battle,
        value: {
            capacity: [],
            geometry: definition.geometry,
            rules: [],
        },
    };
}

export function setRule(state: State, rule: Rule): State {
    const rules = registry.set(state.rules, rule);

    return rules === state.rules ? state : { ...state, rules };
}

export function removeRule(state: State, id: string): State {
    const rules = registry.remove(state.rules, id);

    return rules === state.rules ? state : { ...state, rules };
}

export function canBlock(unit: Unit & Blocker): boolean {
    return unit.blocker.rules.every((rule) => rule.allows(unit));
}

function changeCapacityContributions(
    state: State,
    transition: (
        entries: readonly contribution.Contribution<readonly attribute.Modifier[]>[],
    ) => readonly contribution.Contribution<readonly attribute.Modifier[]>[],
): State {
    const capacity = transition(state.capacity);

    return capacity === state.capacity ? state : { ...state, capacity };
}

export function setCapacityContribution(
    state: State,
    entry: contribution.Contribution<readonly attribute.Modifier[]>,
): State {
    return changeCapacityContributions(state, (entries) => contribution.set(entries, entry));
}

export function removeCapacityContribution(state: State, id: string): State {
    return changeCapacityContributions(state, (entries) => contribution.remove(entries, id));
}

export function resolveCapacity(definition: Definition, state: State): number {
    const value = Math.max(
        0,
        attribute.apply(definition.capacity, contribution.resolve(state.capacity).flat()),
    );
    const lower = Math.floor(value);

    return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value);
}
