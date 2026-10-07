import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import {
    createTileOffset,
    createTilePosition,
    isTilePosition,
    type TilePosition,
} from "../../geometry/coordinate.js";
import { Direction } from "../../geometry/direction.js";
import { RangeGrid } from "../../geometry/range.js";
import type { MechanismId } from "../mechanism.js";
import type { UnitId } from "../../unit/unit.js";

export type SpatialEffectId = number;

export type SpatialEffectSource =
    | { readonly type: "UNIT"; readonly unitId: UnitId }
    | { readonly type: "MECHANISM"; readonly mechanismId: MechanismId };

export type SpatialEffectRegion =
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

export interface NavigationEffectDefinition {
    readonly id: string;
    readonly WALK: WalkNavigationRestriction | null;
    readonly FLY: FlyNavigationRestriction | null;
}

export interface NavigationSpatialEffect {
    readonly id: SpatialEffectId;
    readonly definition: NavigationEffectDefinition;
    readonly source: SpatialEffectSource;
    readonly active: boolean;
    readonly region: SpatialEffectRegion;
    readonly expiresAtTick: number | null;
}

export function copyNavigationSpatialEffect(
    effect: NavigationSpatialEffect,
): NavigationSpatialEffect {
    const range = effect.region.range.map((offset) =>
        Object.isFrozen(offset) ? offset : createTileOffset(...offset),
    );
    let region: SpatialEffectRegion;

    if (effect.region.type === "FIXED") {
        region = {
            ...effect.region,
            range,
            position: Object.isFrozen(effect.region.position)
                ? effect.region.position
                : createTilePosition(...effect.region.position),
        };
    } else {
        region = { ...effect.region, range };
    }

    return { ...effect, source: { ...effect.source }, region };
}

function identity(value: number, name: string): number {
    assertNonnegativeSafeInteger(value, name);

    return value === 0 ? 0 : value;
}

function restriction(value: FlyNavigationRestriction): FlyNavigationRestriction {
    const input: unknown = value;

    if (input === null || typeof input !== "object") {
        throw new TypeError("navigation restriction must be an object");
    }
    if (typeof value.denyPassage !== "boolean") {
        throw new TypeError("denyPassage must be boolean");
    }

    const departuresAreArray: boolean = Array.isArray(value.deniedDepartures);

    if (!departuresAreArray) {
        throw new TypeError("deniedDepartures must be an array");
    }

    const seen = new Set<Direction>();
    const deniedDepartures: Direction[] = [];

    for (let index = 0; index < value.deniedDepartures.length; index++) {
        const direction = value.deniedDepartures[index];

        if (!Object.hasOwn(value.deniedDepartures, index) || !Direction.is(direction)) {
            throw new RangeError(`invalid denied departure at index ${index}`);
        }
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

function source(value: SpatialEffectSource): SpatialEffectSource {
    const input: unknown = value;

    if (input === null || typeof input !== "object") {
        throw new TypeError("spatial effect source must be an object");
    }

    switch (value.type) {
        case "UNIT":
            return Object.freeze({ type: "UNIT", unitId: identity(value.unitId, "unit id") });

        case "MECHANISM":
            return Object.freeze({
                type: "MECHANISM",
                mechanismId: identity(value.mechanismId, "mechanism id"),
            });

        default:
            throw new RangeError("unsupported spatial effect source");
    }
}

export function createNavigationEffectDefinition(
    definition: NavigationEffectDefinition,
): NavigationEffectDefinition {
    if (typeof definition.id !== "string" || definition.id.length === 0) {
        throw new TypeError("navigation effect definition id must be nonempty");
    }

    let WALK: WalkNavigationRestriction | null = null;

    if (definition.WALK !== null) {
        const walk = restriction(definition.WALK);
        const costFloor = definition.WALK.costFloor;

        if (!Number.isInteger(costFloor) || costFloor <= 0 || costFloor > 0x7fffffff) {
            throw new RangeError("WALK cost floor must be a positive int32");
        }

        WALK = Object.freeze({ ...walk, costFloor });
    }

    return Object.freeze({
        id: definition.id,
        WALK,
        FLY: definition.FLY === null ? null : restriction(definition.FLY),
    });
}

export function createSpatialEffectRegion(region: SpatialEffectRegion): SpatialEffectRegion {
    const input: unknown = region;

    if (input === null || typeof input !== "object") {
        throw new TypeError("spatial effect region must be an object");
    }
    if (!Direction.is(region.direction)) {
        throw new RangeError("invalid spatial effect region direction");
    }

    const range = RangeGrid.create(region.range);

    switch (region.type) {
        case "FIXED":
            if (!isTilePosition(region.position)) {
                throw new RangeError("fixed spatial effect position must be a valid tile pair");
            }

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

        default:
            throw new RangeError("unsupported spatial effect region");
    }
}

export function createNavigationSpatialEffect(
    effect: NavigationSpatialEffect,
): NavigationSpatialEffect {
    if (typeof effect.active !== "boolean") {
        throw new TypeError("spatial effect active must be boolean");
    }

    const expiresAtTick =
        effect.expiresAtTick === null
            ? null
            : identity(effect.expiresAtTick, "spatial effect expiry tick");

    return {
        id: identity(effect.id, "spatial effect id"),
        definition: effect.definition,
        source: source(effect.source),
        active: effect.active,
        region: createSpatialEffectRegion(effect.region),
        expiresAtTick,
    };
}
