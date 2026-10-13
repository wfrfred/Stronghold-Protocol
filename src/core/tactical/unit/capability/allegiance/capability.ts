import type { Unit } from "../../unit.js";

export type Side = "ALLY" | "ENEMY" | "NEUTRAL";

export interface Definition {
    readonly side: Side;
}

export interface State {
    readonly side: Side;
}

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

export function areHostileSides(leftSide: Side | undefined, rightSide: Side | undefined): boolean {
    return (
        (leftSide === "ALLY" && rightSide === "ENEMY") ||
        (leftSide === "ENEMY" && rightSide === "ALLY")
    );
}
