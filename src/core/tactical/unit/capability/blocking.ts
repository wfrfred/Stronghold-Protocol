import type { Unit, UnitDefinition } from "../unit.js";

export interface BlockerDefinition {
    readonly capacity: number;
    readonly contactRadius: number;
}

export interface BlockerState {
    readonly capacity: number;
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

export function hasBlocker(unit: Unit): unit is Unit & Blocker {
    return "blocker" in unit;
}

export function hasBlockerDefinition(
    definition: UnitDefinition,
): definition is BlockingUnitDefinition {
    return "blocker" in definition;
}

export function hasBlockable(unit: Unit): unit is Unit & Blockable {
    return "blockable" in unit;
}

export function hasBlockableDefinition(
    definition: UnitDefinition,
): definition is BlockableUnitDefinition {
    return "blockable" in definition;
}

export function createBlockerDefinition(definition: BlockerDefinition): BlockerDefinition {
    if (!Number.isSafeInteger(definition.capacity) || definition.capacity < 0) {
        throw new RangeError("blocking capacity must be a nonnegative safe integer");
    }
    if (!Number.isFinite(definition.contactRadius) || definition.contactRadius < 0) {
        throw new RangeError("blocking contact radius must be finite and nonnegative");
    }

    return Object.freeze({ ...definition });
}

export function createBlockableDefinition(definition: BlockableDefinition): BlockableDefinition {
    if (!Number.isSafeInteger(definition.weight) || definition.weight <= 0) {
        throw new RangeError("blocking weight must be a positive safe integer");
    }

    return Object.freeze({ ...definition });
}

export function copyBlockerState(state: BlockerState): BlockerState {
    return { ...state };
}

export function copyBlockableState(state: BlockableState): BlockableState {
    return { ...state };
}
