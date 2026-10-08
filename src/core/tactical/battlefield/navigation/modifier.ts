import { ownDataRecord } from "../../../common/immutable-data.js";
import { assertNonnegativeSafeInteger, assertPositiveSafeInteger } from "../../../common/assert.js";
import {
    createTileOffset,
    createTilePosition,
    type TilePosition,
} from "../../geometry/coordinate.js";
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

export function copyNavigationModifier(navigationModifier: NavigationModifier): NavigationModifier {
    const range = navigationModifier.region.range.map((offset) =>
        Object.isFrozen(offset) ? offset : createTileOffset(...offset),
    );
    let region: NavigationModifierRegion;

    if (navigationModifier.region.type === "FIXED") {
        region = {
            ...navigationModifier.region,
            range,
            position: Object.isFrozen(navigationModifier.region.position)
                ? navigationModifier.region.position
                : createTilePosition(...navigationModifier.region.position),
        };
    } else {
        region = { ...navigationModifier.region, range };
    }

    return {
        ...navigationModifier,
        definition: ownDataRecord(navigationModifier.definition, "navigation modifier definition"),
        source: { ...navigationModifier.source },
        region,
    };
}

function identity(value: number, name: string): number {
    assertNonnegativeSafeInteger(value, name);

    return value === 0 ? 0 : value;
}

function restriction(value: FlyNavigationRestriction): FlyNavigationRestriction {
    const seen = new Set<Direction>();
    const deniedDepartures: Direction[] = [];

    for (let index = 0; index < value.deniedDepartures.length; index++) {
        if (!Object.hasOwn(value.deniedDepartures, index)) {
            throw new RangeError(`missing denied departure at index ${index}`);
        }

        const direction = value.deniedDepartures[index]!;

        if (seen.has(direction)) {
            throw new RangeError(`duplicate denied departure at index ${index}`);
        }

        seen.add(direction);
        deniedDepartures.push(direction);
    }

    return Object.freeze({
        denyPassage: value.denyPassage,
        deniedDepartures: Object.freeze(deniedDepartures),
    });
}

function source(value: NavigationModifierSource): NavigationModifierSource {
    switch (value.type) {
        case "UNIT":
            return Object.freeze({ type: "UNIT", unitId: identity(value.unitId, "unit id") });

        case "MECHANISM":
            return Object.freeze({
                type: "MECHANISM",
                mechanismId: identity(value.mechanismId, "mechanism id"),
            });
    }
}

export function createNavigationModifierDefinition(
    definition: NavigationModifierDefinition,
): NavigationModifierDefinition {
    if (definition.id.length === 0) {
        throw new TypeError("navigation modifier definition id must be nonempty");
    }

    let WALK: WalkNavigationRestriction | null = null;

    if (definition.WALK !== null) {
        const walk = restriction(definition.WALK);
        const costFloor = definition.WALK.costFloor;

        assertPositiveSafeInteger(costFloor, "WALK cost floor");

        WALK = Object.freeze({ ...walk, costFloor });
    }

    return ownDataRecord(
        {
            id: definition.id,
            WALK,
            FLY: definition.FLY === null ? null : restriction(definition.FLY),
        },
        "navigation modifier definition",
    );
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
    const expiresAtTick =
        navigationModifier.expiresAtTick === null
            ? null
            : identity(navigationModifier.expiresAtTick, "navigation modifier expiry tick");

    return {
        id: identity(navigationModifier.id, "navigation modifier id"),
        definition: ownDataRecord(navigationModifier.definition, "navigation modifier definition"),
        source: source(navigationModifier.source),
        active: navigationModifier.active,
        region: createNavigationModifierRegion(navigationModifier.region),
        expiresAtTick,
    };
}
