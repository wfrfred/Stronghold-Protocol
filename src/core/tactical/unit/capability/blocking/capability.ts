import {
    assertNonnegativeSafeInteger,
    assertPositiveSafeInteger,
} from "../../../../common/assert.js";
import { createBlockGeometry, type BlockGeometry } from "../../../geometry/shape.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import type { Unit, Definition } from "../../unit.js";

export interface BlockerDefinition {
    readonly capacity: number;
    readonly geometry: BlockGeometry;
}

export interface BlockerState {
    readonly capacity: readonly contribution.Contribution[];
    readonly geometry: BlockGeometry;
    readonly enabled: boolean;
}

export interface Blocker {
    readonly definition: {
        readonly blocker: BlockerDefinition;
    };
    readonly blocker: BlockerState;
}

export interface BlockingUnitDefinition extends Definition {
    readonly blocker: BlockerDefinition;
}

export interface BlockableDefinition {
    readonly weight: number;
}

export interface BlockableState {
    readonly weight: number;
    readonly enabled: boolean;
}

export interface Blockable {
    readonly definition: {
        readonly blockable: BlockableDefinition;
    };
    readonly blockable: BlockableState;
}

export interface BlockableUnitDefinition extends Definition {
    readonly blockable: BlockableDefinition;
}

export function hasBlocker<U extends Unit>(unit: U): unit is U & Blocker {
    return "blocker" in unit && "blocker" in unit.definition;
}

export function hasBlockable<U extends Unit>(unit: U): unit is U & Blockable {
    return "blockable" in unit && "blockable" in unit.definition;
}

export function createBlockerDefinition(definition: BlockerDefinition): BlockerDefinition {
    assertNonnegativeSafeInteger(definition.capacity, "blocking capacity");

    return Object.freeze({
        capacity: definition.capacity,
        geometry: createBlockGeometry(definition.geometry),
    });
}

export function createBlockableDefinition(definition: BlockableDefinition): BlockableDefinition {
    assertPositiveSafeInteger(definition.weight, "blocking weight");

    return Object.freeze({ ...definition });
}

export function initializeBlockerState(definition: BlockerDefinition): BlockerState {
    return {
        capacity: [],
        geometry: definition.geometry,
        enabled: true,
    };
}

export function initializeBlockableState(definition: BlockableDefinition): BlockableState {
    return { weight: definition.weight, enabled: true };
}

function changeCapacityContributions(
    state: BlockerState,
    transition: (
        entries: readonly contribution.Contribution[],
    ) => readonly contribution.Contribution[],
): BlockerState {
    const capacity = transition(state.capacity);

    return capacity === state.capacity ? state : { ...state, capacity };
}

export function setCapacityContribution(
    state: BlockerState,
    entry: contribution.Contribution,
): BlockerState {
    return changeCapacityContributions(state, (entries) => contribution.set(entries, entry));
}

export function removeCapacityContribution(state: BlockerState, id: string): BlockerState {
    return changeCapacityContributions(state, (entries) => contribution.remove(entries, id));
}

export function resolveBlockingCapacity(
    definition: BlockerDefinition,
    state: BlockerState,
): number {
    const value = Math.max(
        0,
        modifier.apply(definition.capacity, contribution.resolve(state.capacity)),
    );
    const lower = Math.floor(value);

    return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value);
}
