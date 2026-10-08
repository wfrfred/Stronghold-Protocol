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

export function hasAllegiance<U extends Unit>(
    unit: U,
): unit is U & Allegiance & Unit<U["definition"] & AllegiantUnitDefinition> {
    return "allegiance" in unit && "allegiance" in unit.definition;
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

export function initializeAllegianceState(definition: AllegianceState): AllegianceState {
    return copyAllegianceState(definition);
}

export function areHostile(left: Unit, right: Unit): boolean {
    if (!hasAllegiance(left) || !hasAllegiance(right)) {
        return false;
    }

    return areHostileSides(left.allegiance.side, right.allegiance.side);
}

export function areHostileSides(
    leftSide: AllegianceState["side"] | undefined,
    rightSide: AllegianceState["side"] | undefined,
): boolean {
    return (
        (leftSide === "ALLY" && rightSide === "ENEMY") ||
        (leftSide === "ENEMY" && rightSide === "ALLY")
    );
}
