import { assertNonnegativeSafeInteger, assertPositiveSafeInteger } from "../../../common/assert.js";
import { createTilePosition, type TilePosition } from "../../geometry/coordinate.js";
import type { Direction } from "../../geometry/direction.js";
import { RangeGrid } from "../../geometry/range.js";
import type { MechanismId } from "../mechanism.js";
import type { UnitId } from "../../unit/unit.js";

export type NavigationModifierId = number;

export type NavigationModifierSource =
    | { readonly type: "UNIT"; readonly unitId: UnitId }
    | { readonly type: "MECHANISM"; readonly mechanismId: MechanismId };

export type NavigationModifierRegion =
    | {
          readonly type: "FIXED";
          readonly position: TilePosition;
          readonly range: RangeGrid;
          readonly direction: Direction;
      }
    | {
          readonly type: "FOLLOW_UNIT";
          readonly unitId: UnitId;
          readonly range: RangeGrid;
          readonly direction: Direction;
      };

export interface WalkNavigationRestriction {
    readonly denyPassage: boolean;
    readonly deniedDepartures: readonly Direction[];
    readonly costFloor: number;
}

export interface FlyNavigationRestriction {
    readonly denyPassage: boolean;
    readonly deniedDepartures: readonly Direction[];
}

export interface NavigationModifierDefinition {
    readonly id: string;
    readonly WALK: WalkNavigationRestriction | null;
    readonly FLY: FlyNavigationRestriction | null;
}

export interface NavigationModifier {
    readonly id: NavigationModifierId;
    readonly definition: NavigationModifierDefinition;
    readonly source: NavigationModifierSource;
    readonly active: boolean;
    readonly region: NavigationModifierRegion;
    readonly expiresAtTick: number | null;
}

function identity(value: number, name: string): number {
    assertNonnegativeSafeInteger(value, name);

    return value === 0 ? 0 : value;
}

function validateRestriction(value: FlyNavigationRestriction): void {
    const seen = new Set<Direction>();

    for (const direction of value.deniedDepartures) {
        if (seen.has(direction)) {
            throw new RangeError(`duplicate denied departure ${direction}`);
        }

        seen.add(direction);
    }
}

export function createNavigationModifierDefinition(
    definition: NavigationModifierDefinition,
): NavigationModifierDefinition {
    if (definition.id.length === 0) {
        throw new TypeError("navigation modifier definition id must be nonempty");
    }
    if (definition.WALK !== null) {
        validateRestriction(definition.WALK);
        assertPositiveSafeInteger(definition.WALK.costFloor, "WALK cost floor");
    }
    if (definition.FLY !== null) {
        validateRestriction(definition.FLY);
    }

    return definition;
}

export function createNavigationModifierRegion(
    region: NavigationModifierRegion,
): NavigationModifierRegion {
    const range = RangeGrid.create(region.range);

    switch (region.type) {
        case "FIXED":
            return Object.freeze({
                type: "FIXED",
                position: createTilePosition(region.position[0], region.position[1]),
                range,
                direction: region.direction,
            });

        case "FOLLOW_UNIT":
            return Object.freeze({
                type: "FOLLOW_UNIT",
                unitId: identity(region.unitId, "followed unit id"),
                range,
                direction: region.direction,
            });
    }
}

export function createNavigationModifier(
    navigationModifier: NavigationModifier,
): NavigationModifier {
    assertNonnegativeSafeInteger(navigationModifier.id, "navigation modifier id");

    if (navigationModifier.expiresAtTick !== null) {
        assertNonnegativeSafeInteger(
            navigationModifier.expiresAtTick,
            "navigation modifier expiry tick",
        );
    }

    const source = navigationModifier.source;

    if (source.type === "UNIT") {
        assertNonnegativeSafeInteger(source.unitId, "unit id");
    } else {
        assertNonnegativeSafeInteger(source.mechanismId, "mechanism id");
    }

    return {
        ...navigationModifier,
        region: createNavigationModifierRegion(navigationModifier.region),
    };
}
