import {
    type BuildableType,
    type DeepseaParams,
    type HeightType,
    type InfectionParams,
    type MireParams,
    type PassableMask,
    type PlayerSideMask,
    type Tile,
    type TileMechanism,
} from "../../core/tactical/battlefield/tile.js";
import {
    createBattlefieldMap,
    type BattlefieldBlockEdge,
    type BattlefieldMap,
    type BattlefieldMarker,
} from "../../core/tactical/battlefield/map.js";
import {
    createTilePosition,
    type TilePosition,
} from "../../core/tactical/geometry/coordinate.js";
import { Direction } from "../../core/tactical/geometry/direction.js";
import { perSecondToPerTick, secondsToTicks } from "./tick.js";
import { parseBlackboard, type ArknightsBlackboardEntry } from "./blackboard.js";

export interface ArknightsTileContext {
    readonly tileKey: string;
    readonly position: TilePosition;
}

export interface ArknightsMapOptions {
    readonly mire?: MireParams;
    readonly deepsea?: DeepseaParams;
    readonly consumeTileBlackboard?: (
        context: ArknightsTileContext,
        entry: ArknightsBlackboardEntry,
    ) => boolean;
}

const ORDINARY_TILE_KEYS = new Set([
    "tile_forbidden",
    "tile_road",
    "tile_floor",
    "tile_wall",
    "tile_achand",
    "tile_fence_bound",
    "tile_start",
    "tile_end",
    "tile_telin",
    "tile_telout",
]);

const MARKER_TYPES = {
    tile_start: "START",
    tile_end: "END",
    tile_telin: "TELEPORT_IN",
    tile_telout: "TELEPORT_OUT",
} as const satisfies Record<string, BattlefieldMarker["type"]>;

function record(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }
    return value as Record<string, unknown>;
}

function array(value: unknown, name: string): readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${name} must be an array`);
    }
    for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index) || value[index] === undefined) {
            throw new RangeError(`${name} is missing index ${index}`);
        }
    }
    return value;
}

function string(value: unknown, name: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${name} must be a string`);
    }
    return value;
}

function finite(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new RangeError(`${name} must be a finite number`);
    }
    return value;
}

function requireKnownFields(
    source: Record<string, unknown>,
    fields: readonly string[],
    name: string,
): void {
    for (const key of Object.keys(source)) {
        if (!fields.includes(key)) {
            throw new TypeError(`${name} has unsupported field ${key}`);
        }
    }
}

function requireEmpty(value: unknown, name: string): void {
    if (value !== undefined && value !== null && array(value, name).length !== 0) {
        throw new TypeError(`${name} is not supported`);
    }
}

function tileBlackboard(value: unknown): readonly ArknightsBlackboardEntry[] {
    if (value === null || value === undefined) {
        return Object.freeze([]);
    }
    return parseBlackboard(value, "tile blackboard", { allowEmptyKeys: true, allowMissingValueStr: true });
}

function parseTile(
    value: unknown,
    position: TilePosition,
    options: ArknightsMapOptions,
): { readonly tile: Tile; readonly marker: BattlefieldMarker | null } {
    const source = record(value, "tile definition");
    requireKnownFields(source, [
        "tileKey", "heightType", "buildableType", "passableMask",
        "playerSideMask", "advancedBuildableMask", "blackboard", "effects",
    ], "tile definition");
    const tileKey = string(source.tileKey, "tile key");
    if (source.advancedBuildableMask !== undefined && source.advancedBuildableMask !== null &&
        source.advancedBuildableMask !== 0) {
        throw new TypeError(`unsupported advanced buildable mask for ${tileKey}`);
    }
    requireEmpty(source.effects, `${tileKey} effects`);
    const blackboard = tileBlackboard(source.blackboard);
    const consumed = new Set<string>();
    let mechanism: TileMechanism | null = null;

    switch (tileKey) {
        case "tile_infection": {
            function parameter(key: string): number {
                const entry = blackboard.find((item) => item.key === key);
                if (entry === undefined || entry.valueStr !== null) {
                    throw new TypeError(`infection requires numeric blackboard ${key}`);
                }
                consumed.add(key);
                return entry.value;
            }
            const params: InfectionParams = {
                damagePerTick: perSecondToPerTick(parameter("damage")),
                attackBonusRatio: parameter("atk"),
                attackSpeedBonus: parameter("attack_speed"),
                activeUntilTick: secondsToTicks(parameter("duration"), "infection duration"),
            };
            mechanism = { type: "INFECTION", params };
            break;
        }
        case "tile_mire":
            if (options.mire === undefined) {
                throw new TypeError("mire controller parameters must be supplied explicitly");
            }
            mechanism = { type: "MIRE", params: options.mire };
            break;
        case "tile_deepsea":
            if (options.deepsea === undefined) {
                throw new TypeError("deepsea controller parameters must be supplied explicitly");
            }
            mechanism = { type: "DEEPSEA", params: options.deepsea };
            break;
        case "tile_smog":
            mechanism = { type: "SMOG" };
            break;
        default:
            if (!ORDINARY_TILE_KEYS.has(tileKey)) {
                throw new TypeError(`unsupported tile key ${tileKey}`);
            }
    }

    const context = Object.freeze({ tileKey, position });
    for (const entry of blackboard) {
        if (!consumed.has(entry.key) && options.consumeTileBlackboard?.(context, entry) !== true) {
            throw new TypeError(`unconsumed blackboard ${entry.key} for ${tileKey}`);
        }
    }

    const tile: Tile = {
        heightType: string(source.heightType, "tile height type") as HeightType,
        buildableType: string(source.buildableType, "tile buildable type") as BuildableType,
        passableMask: string(source.passableMask, "tile passable mask") as PassableMask,
        playerSideMask: string(source.playerSideMask, "tile player side mask") as PlayerSideMask,
        terrain: "NORMAL",
        mechanism,
    };
    const markerType = MARKER_TYPES[tileKey as keyof typeof MARKER_TYPES];
    return {
        tile,
        marker: markerType === undefined ? null : { type: markerType, position },
    };
}

function parseBlockEdge(value: unknown): BattlefieldBlockEdge {
    const source = record(value, "block edge");
    requireKnownFields(source, ["pos", "direction", "blockMask"], "block edge");
    const pos = record(source.pos, "block edge position");
    requireKnownFields(pos, ["row", "col"], "block edge position");
    const direction = source.direction;
    if (!Direction.is(direction)) {
        throw new TypeError("unsupported block edge direction");
    }
    return {
        position: createTilePosition(finite(pos.row, "block edge row"), finite(pos.col, "block edge column")),
        direction,
        blockMask: string(source.blockMask, "block edge mask") as PassableMask,
    };
}

export function parseBattlefieldMap(
    value: unknown,
    options: ArknightsMapOptions = {},
): BattlefieldMap {
    const source = record(value, "map data");
    requireKnownFields(source, ["map", "tiles", "blockEdges", "tags", "effects", "layerRects"], "map data");
    requireEmpty(source.tags, "map tags");
    requireEmpty(source.effects, "map effects");
    requireEmpty(source.layerRects, "map layers");
    const matrix = array(source.map, "map matrix");
    if (matrix.length === 0) {
        throw new RangeError("map matrix must have at least one row");
    }
    const columns = array(matrix[0], "map row").length;
    if (columns === 0) {
        throw new RangeError("map matrix must have at least one column");
    }
    const tileCount = matrix.length * columns;
    if (!Number.isSafeInteger(tileCount) || tileCount > 0xffff_ffff) {
        throw new RangeError("map dimensions exceed the supported array length");
    }
    const definitions = array(source.tiles, "tile definitions");
    const tiles: Tile[] = [];
    const markers: BattlefieldMarker[] = [];

    for (let row = 0; row < matrix.length; row++) {
        const rawRow = array(matrix[matrix.length - row - 1], "map row");
        if (rawRow.length !== columns) {
            throw new RangeError("map matrix must be rectangular");
        }
        for (let col = 0; col < columns; col++) {
            const definitionIndex = finite(rawRow[col], "tile definition index");
            if (!Number.isSafeInteger(definitionIndex) || definitionIndex < 0 || definitionIndex >= definitions.length) {
                throw new RangeError(`invalid tile definition index ${definitionIndex}`);
            }
            const parsed = parseTile(definitions[definitionIndex], createTilePosition(row, col), options);
            tiles.push(parsed.tile);
            if (parsed.marker !== null) {
                markers.push(parsed.marker);
            }
        }
    }

    const blockEdges = source.blockEdges === null || source.blockEdges === undefined
        ? []
        : array(source.blockEdges, "block edges").map(parseBlockEdge);
    return createBattlefieldMap(matrix.length, columns, tiles, markers, blockEdges);
}
