import { World } from "../../geometry/coordinate.js";
import {
    hasOccupancy,
    isOccupancyClaimActive,
    type OccupancyClaim,
} from "../../unit/capability/occupancy/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import type { Unit, Id } from "../../unit/unit.js";
import type { BattlefieldMap } from "../map/map.js";
import { battlefieldTileKey } from "./indexes.js";
import type { BattlefieldContent, BattlefieldState } from "./state.js";
import { readBlockingFacts, sameBlockingFacts } from "../blocking/facts.js";
import { readSupportFacts, sameSupportFacts } from "../support/facts.js";

export interface BattlefieldDependencyChanges {
    readonly updatedUnitIds: ReadonlySet<Id>;
    readonly unitMembershipChanged: boolean;
}

const EMPTY_CLAIMS: readonly OccupancyClaim[] = Object.freeze([]);

function sameClaims(left: readonly OccupancyClaim[], right: readonly OccupancyClaim[]): boolean {
    return (
        left === right ||
        (left.length === right.length &&
            left.every((claim, index) => {
                const other = right[index]!;

                return (
                    claim.slot === other.slot &&
                    claim.type === other.type &&
                    claim.position[0] === other.position[0] &&
                    claim.position[1] === other.position[1]
                );
            }))
    );
}

function sameOccupancyInputs(left: Unit, right: Unit): boolean {
    const leftClaims = hasOccupancy(left) ? left.occupancy.claims : EMPTY_CLAIMS;
    const rightClaims = hasOccupancy(right) ? right.occupancy.claims : EMPTY_CLAIMS;

    if (leftClaims === rightClaims && isSpatiallyPresent(left) === isSpatiallyPresent(right)) {
        return true;
    }

    return sameClaims(
        leftClaims.filter((claim) => isOccupancyClaimActive(left, claim)),
        rightClaims.filter((claim) => isOccupancyClaimActive(right, claim)),
    );
}

export function deriveBattlefieldDependencies<U extends Unit>(
    map: BattlefieldMap,
    previous: BattlefieldState<U>,
    content: BattlefieldContent<U>,
    changes: BattlefieldDependencyChanges,
) {
    let unitTiles = changes.unitMembershipChanged;
    let occupancy = changes.unitMembershipChanged;
    let support = changes.unitMembershipChanged;
    let blocking = changes.unitMembershipChanged;

    for (const id of changes.updatedUnitIds) {
        const left = previous.units.get(id);
        const right = content.units.get(id);

        if (left === undefined || right === undefined) {
            continue;
        }

        unitTiles ||= isSpatiallyPresent(left) !== isSpatiallyPresent(right);

        if (isSpatiallyPresent(left) && isSpatiallyPresent(right)) {
            unitTiles ||=
                battlefieldTileKey(map, World.toTile(left.position)) !==
                battlefieldTileKey(map, World.toTile(right.position));
        }

        occupancy ||= !sameOccupancyInputs(left, right);
        support ||= !sameSupportFacts(readSupportFacts(left), readSupportFacts(right));
        blocking ||= !sameBlockingFacts(map, readBlockingFacts(left), readBlockingFacts(right));
    }

    return { unitTiles, occupancy, support, blocking };
}
