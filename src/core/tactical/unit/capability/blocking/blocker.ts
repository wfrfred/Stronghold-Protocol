import * as registry from "../../hook/hook.js";
import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import { createBlockGeometry, type BlockGeometry } from "../../../geometry/shape.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import type { Unit } from "../../unit.js";

export interface Definition {
    readonly capacity: number;
    readonly geometry: BlockGeometry;
}

export interface Rule {
    readonly id: string;
    readonly allows: (unit: Unit) => boolean;
}

export interface State {
    readonly capacity: readonly contribution.Contribution[];
    readonly geometry: BlockGeometry;
    readonly enabled: boolean;
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

export function createDefinition(definition: Definition): Definition {
    assertNonnegativeSafeInteger(definition.capacity, "blocking capacity");

    return Object.freeze({
        capacity: definition.capacity,
        geometry: createBlockGeometry(definition.geometry),
    });
}

export function initialize(definition: Definition): State {
    return {
        capacity: [],
        geometry: definition.geometry,
        enabled: true,
        rules: [],
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
    return unit.blocker.enabled && unit.blocker.rules.every((rule) => rule.allows(unit));
}

function changeCapacityContributions(
    state: State,
    transition: (
        entries: readonly contribution.Contribution[],
    ) => readonly contribution.Contribution[],
): State {
    const capacity = transition(state.capacity);

    return capacity === state.capacity ? state : { ...state, capacity };
}

export function setCapacityContribution(state: State, entry: contribution.Contribution): State {
    return changeCapacityContributions(state, (entries) => contribution.set(entries, entry));
}

export function removeCapacityContribution(state: State, id: string): State {
    return changeCapacityContributions(state, (entries) => contribution.remove(entries, id));
}

export function resolveCapacity(definition: Definition, state: State): number {
    const value = Math.max(
        0,
        modifier.apply(definition.capacity, contribution.resolve(state.capacity)),
    );
    const lower = Math.floor(value);

    return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value);
}
