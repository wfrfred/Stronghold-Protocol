import { assertNonnegativeSafeInteger, assertPositiveSafeInteger } from "../../../common/assert.js";
import { createBlockGeometry, type BlockGeometry } from "../../geometry/shape.js";
import type { Unit, UnitDefinition } from "../unit.js";

export interface BlockerDefinition {
    readonly capacity: number;
    readonly geometry: BlockGeometry;
}

export interface BlockerState {
    readonly capacity: number;
    readonly geometry: BlockGeometry;
    readonly enabled: boolean;
}

export interface Blocker {
    readonly blocker: BlockerState;
}

export interface BlockingUnitDefinition extends UnitDefinition {
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
    readonly blockable: BlockableState;
}

export interface BlockableUnitDefinition extends UnitDefinition {
    readonly blockable: BlockableDefinition;
}

export function hasBlocker<U extends Unit>(
    unit: U,
): unit is U & Blocker & Unit<U["definition"] & BlockingUnitDefinition> {
    return "blocker" in unit && "blocker" in unit.definition;
}

export function hasBlockable<U extends Unit>(
    unit: U,
): unit is U & Blockable & Unit<U["definition"] & BlockableUnitDefinition> {
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

export function copyBlockerState(state: BlockerState): BlockerState {
    return { ...state, geometry: createBlockGeometry(state.geometry) };
}

export function copyBlockableState(state: BlockableState): BlockableState {
    return { ...state };
}

export function initializeBlockerState(definition: BlockerDefinition): BlockerState {
    return {
        capacity: definition.capacity,
        geometry: createBlockGeometry(definition.geometry),
        enabled: true,
    };
}

export function initializeBlockableState(definition: BlockableDefinition): BlockableState {
    return { weight: definition.weight, enabled: true };
}
