import { hasTileBindingDefinition } from "../../unit/capability/deployment.js";
import { hasOccupancy, type OccupancyClaim } from "../../unit/capability/occupancy.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import type { Unit } from "../../unit/unit.js";

export interface SupportFacts {
    readonly present: boolean;
    readonly provider: boolean;
    readonly claims: readonly OccupancyClaim[];
}

const EMPTY_CLAIMS: readonly OccupancyClaim[] = Object.freeze([]);

export function readSupportFacts(unit: Unit): SupportFacts {
    return {
        present: isSpatiallyPresent(unit),
        provider:
            hasTileBindingDefinition(unit.definition) &&
            unit.definition.tileBinding.buildableType !== "NONE",
        claims: hasOccupancy(unit)
            ? unit.occupancy.claims.filter((claim) => claim.type === "PRESENT")
            : EMPTY_CLAIMS,
    };
}

export function sameSupportFacts(left: SupportFacts, right: SupportFacts): boolean {
    return (
        left.present === right.present &&
        left.provider === right.provider &&
        (left.claims === right.claims ||
            (left.claims.length === right.claims.length &&
                left.claims.every((claim, index) => {
                    const other = right.claims[index]!;

                    return (
                        claim.slot === other.slot &&
                        claim.position[0] === other.position[0] &&
                        claim.position[1] === other.position[1]
                    );
                })))
    );
}
