import type { Unit } from "../unit.js";

export interface Definition {
    readonly side: "ALLY" | "ENEMY" | "NEUTRAL";
}

export type State = Definition;

export interface Allegiance {
    readonly definition: { readonly allegiance: Definition };
    readonly allegiance: State;
}

export function hasAllegiance<U extends Unit>(unit: U): unit is U & Allegiance {
    return "allegiance" in unit && "allegiance" in unit.definition;
}

export function initialize(definition: Definition): State {
    return definition;
}

export function areHostile(left: Unit, right: Unit): boolean {
    if (!hasAllegiance(left) || !hasAllegiance(right)) {
        return false;
    }

    return areHostileSides(left.allegiance.side, right.allegiance.side);
}

export function areHostileSides(
    leftSide: State["side"] | undefined,
    rightSide: State["side"] | undefined,
): boolean {
    return (
        (leftSide === "ALLY" && rightSide === "ENEMY") ||
        (leftSide === "ENEMY" && rightSide === "ALLY")
    );
}
