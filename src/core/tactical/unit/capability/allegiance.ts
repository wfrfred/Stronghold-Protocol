import type { Unit, UnitDefinition } from "../unit.js";

export interface AllegianceState {
    readonly side: "ALLY" | "ENEMY" | "NEUTRAL";
}

export interface Allegiance {
    readonly allegiance: AllegianceState;
}

export interface AllegiantUnitDefinition extends UnitDefinition {
    readonly allegiance: AllegianceState;
}

export function hasAllegiance(unit: Unit): unit is Unit & Allegiance {
    return "allegiance" in unit;
}

export function hasAllegianceDefinition(
    definition: UnitDefinition,
): definition is AllegiantUnitDefinition {
    return "allegiance" in definition;
}

export function createAllegianceState(state: Readonly<AllegianceState>): AllegianceState {
    const side: unknown = state.side;

    if (side !== "ALLY" && side !== "ENEMY" && side !== "NEUTRAL") {
        throw new RangeError("unsupported allegiance side");
    }

    return Object.freeze({ side });
}

export function copyAllegianceState(state: Readonly<AllegianceState>): AllegianceState {
    return { ...state };
}

export function areHostile(left: Unit, right: Unit): boolean {
    if (!hasAllegiance(left) || !hasAllegiance(right)) {
        return false;
    }

    const leftSide = left.allegiance.side;
    const rightSide = right.allegiance.side;

    return (
        (leftSide === "ALLY" && rightSide === "ENEMY") ||
        (leftSide === "ENEMY" && rightSide === "ALLY")
    );
}
