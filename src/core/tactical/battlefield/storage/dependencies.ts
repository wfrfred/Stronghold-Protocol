import { World } from "../../geometry/coordinate.js";
import {
    hasOccupancy,
    isOccupancyClaimActive,
    type OccupancyClaim,
} from "../../unit/capability/occupancy.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { BattlefieldMap } from "../map/map.js";
import type { MechanismId } from "../mechanism.js";
import type { NavigationModifierId, NavigationModifierRegion } from "../navigation/modifier.js";
import { battlefieldTileKey, navigationModifierSourceKey } from "./indexes.js";
import type { BattlefieldContent, BattlefieldState } from "./state.js";
import { readBlockingFacts, sameBlockingFacts } from "../blocking/facts.js";
import { readSupportFacts, sameSupportFacts } from "../support/facts.js";

export interface BattlefieldDependencyChanges {
    readonly updatedUnitIds: ReadonlySet<UnitId>;
    readonly updatedMechanismIds: ReadonlySet<MechanismId>;
    readonly updatedNavigationModifierIds: ReadonlySet<NavigationModifierId>;
    readonly unitMembershipChanged: boolean;
    readonly navigationModifierMembershipChanged: boolean;
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

function sameRegion(left: NavigationModifierRegion, right: NavigationModifierRegion): boolean {
    if (left === right) {
        return true;
    }
    if (
        left.type !== right.type ||
        left.direction !== right.direction ||
        left.range.length !== right.range.length
    ) {
        return false;
    }
    if (left.type === "FIXED") {
        if (
            right.type !== "FIXED" ||
            left.position[0] !== right.position[0] ||
            left.position[1] !== right.position[1]
        ) {
            return false;
        }
    } else if (right.type !== "FOLLOW_UNIT" || left.unitId !== right.unitId) {
        return false;
    }

    return left.range.every((offset, index) => {
        const other = right.range[index]!;

        return offset[0] === other[0] && offset[1] === other[1];
    });
}

function anchorId(region: NavigationModifierRegion): UnitId | undefined {
    return region.type === "FOLLOW_UNIT" ? region.unitId : undefined;
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
    let navigationModifierRelations = changes.navigationModifierMembershipChanged;
    let navigationModifierCoverage = changes.navigationModifierMembershipChanged;

    for (const id of changes.updatedUnitIds) {
        const left = previous.units.get(id);
        const right = content.units.get(id);

        if (left === undefined || right === undefined) {
            continue;
        }

        const presenceChanged = isSpatiallyPresent(left) !== isSpatiallyPresent(right);
        const anchors = previous.spatial.navigationModifiersByAnchor.get(id);
        const retainedAnchor =
            anchors !== undefined &&
            [...anchors].some((navigationModifierId) => {
                const navigationModifier = content.navigationModifiers.get(navigationModifierId);

                return (
                    navigationModifier?.region.type === "FOLLOW_UNIT" &&
                    navigationModifier.region.unitId === id
                );
            });

        let tileChanged = false;

        unitTiles ||= presenceChanged;

        if ((isSpatiallyPresent(left) && isSpatiallyPresent(right)) || retainedAnchor) {
            const leftTile = World.toTile(left.position);
            const rightTile = World.toTile(right.position);
            tileChanged = leftTile[0] !== rightTile[0] || leftTile[1] !== rightTile[1];

            unitTiles ||=
                isSpatiallyPresent(right) &&
                battlefieldTileKey(map, leftTile) !== battlefieldTileKey(map, rightTile);
        }

        occupancy ||= !sameOccupancyInputs(left, right);
        support ||= !sameSupportFacts(readSupportFacts(left), readSupportFacts(right));
        blocking ||= !sameBlockingFacts(map, readBlockingFacts(left), readBlockingFacts(right));
        navigationModifierCoverage ||=
            (presenceChanged && previous.spatial.navigationModifiersBySource.has(`UNIT:${id}`)) ||
            ((presenceChanged || tileChanged) && retainedAnchor);
    }

    for (const id of changes.updatedMechanismIds) {
        const left = previous.mechanisms.get(id);
        const right = content.mechanisms.get(id);

        navigationModifierCoverage ||=
            left?.active !== right?.active &&
            previous.spatial.navigationModifiersBySource.has(`MECHANISM:${id}`);
    }

    for (const id of changes.updatedNavigationModifierIds) {
        const left = previous.navigationModifiers.get(id);
        const right = content.navigationModifiers.get(id);

        if (left === undefined || right === undefined) {
            continue;
        }

        const sourceChanged =
            navigationModifierSourceKey(left.source) !== navigationModifierSourceKey(right.source);

        navigationModifierRelations ||=
            sourceChanged || anchorId(left.region) !== anchorId(right.region);
        navigationModifierCoverage ||=
            sourceChanged ||
            left.active !== right.active ||
            left.definition !== right.definition ||
            !sameRegion(left.region, right.region);
    }

    return {
        unitTiles,
        occupancy,
        support,
        blocking,
        navigationModifierRelations,
        navigationModifierCoverage,
    };
}
