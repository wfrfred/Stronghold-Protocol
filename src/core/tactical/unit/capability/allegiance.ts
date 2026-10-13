import type { Unit } from "../unit.js";

export interface AllegianceState {
    readonly side: "ALLY" | "ENEMY" | "NEUTRAL";
}

export interface Allegiance {
    readonly definition: { readonly allegiance: AllegianceState };
    readonly allegiance: AllegianceState;
}

export function hasAllegiance<U extends Unit>(unit: U): unit is U & Allegiance {
    return "allegiance" in unit && "allegiance" in unit.definition;
}

export function initializeAllegianceState(definition: AllegianceState): AllegianceState {
    return definition;
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
