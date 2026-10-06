import { createTile, type PassableMask, type Tile } from "./tile.js";
import { createTilePosition, isTilePosition } from "../geometry/coordinate.js";
import type { TilePosition } from "../geometry/coordinate.js";
import { Direction } from "../geometry/direction.js";

export interface BattlefieldMarker {
    readonly type: "START" | "END" | "TELEPORT_IN" | "TELEPORT_OUT";
    readonly position: TilePosition;
}

export interface BattlefieldBlockEdge {
    readonly position: TilePosition;
    readonly direction: Direction;
    readonly blockMask: PassableMask;
}

export interface BattlefieldMap {
    readonly rows: number;
    readonly columns: number;
    readonly tiles: readonly Tile[];
    readonly markers: readonly BattlefieldMarker[];
    readonly blockEdges: readonly BattlefieldBlockEdge[];
}

export const BattlefieldMap = {
    contains(map: BattlefieldMap, position: TilePosition): boolean {
        const [row, col] = position;

        return row >= 0 && row < map.rows &&
            col >= 0 && col < map.columns;
    },

    get(map: BattlefieldMap, position: TilePosition): Tile | undefined {
        if (!BattlefieldMap.contains(map, position)) {
            return undefined;
        }

        const [row, col] = position;
        return map.tiles[row * map.columns + col];
    }
};

export function createBattlefieldMap(
    rows: number,
    columns: number,
    tiles: readonly Tile[],
    markers: readonly BattlefieldMarker[] = [],
    blockEdges: readonly BattlefieldBlockEdge[] = [],
): BattlefieldMap {
    if (!Number.isSafeInteger(rows) || rows <= 0) {
        throw new RangeError(`invalid row count: ${rows}`);
    }

    if (!Number.isSafeInteger(columns) || columns <= 0) {
        throw new RangeError(`invalid column count: ${columns}`);
    }

    const tileCount = rows * columns;
    if (!Number.isSafeInteger(tileCount) || tileCount > 0xffff_ffff) {
        throw new RangeError("map dimensions exceed the supported array length");
    }
    if (!Array.isArray(tiles) || tiles.length !== tileCount) {
        throw new RangeError(
            `expected ${rows * columns} tiles, got ${tiles.length}`,
        );
    }
    if (!Array.isArray(markers) || !Array.isArray(blockEdges)) {
        throw new TypeError("map markers and block edges must be arrays");
    }

    const copiedTiles: Tile[] = [];
    for (let index = 0; index < tiles.length; index++) {
        if (!Object.hasOwn(tiles, index) || tiles[index] === undefined) {
            throw new RangeError(`missing tile at index ${index}`);
        }
        copiedTiles.push(createTile(tiles[index]));
    }

    const copiedMarkers: BattlefieldMarker[] = [];
    const copiedBlockEdges: BattlefieldBlockEdge[] = [];
    const map: BattlefieldMap = {
        rows,
        columns,
        tiles: copiedTiles,
        markers: copiedMarkers,
        blockEdges: copiedBlockEdges,
    };

    for (let index = 0; index < markers.length; index++) {
        const marker = markers[index];
        if (!Object.hasOwn(markers, index) || marker === undefined) {
            throw new RangeError(`missing marker at index ${index}`);
        }
        if (!["START", "END", "TELEPORT_IN", "TELEPORT_OUT"].includes(marker.type)) {
            throw new TypeError(`invalid marker type at index ${index}`);
        }
        if (!isTilePosition(marker.position)) {
            throw new RangeError("tile position must contain exactly two safe integer coordinates");
        }
        if (!BattlefieldMap.contains(map, marker.position)) {
            throw new RangeError(`marker at index ${index} is outside the map`);
        }
        const [row, col] = marker.position;
        copiedMarkers.push(Object.freeze({
            type: marker.type,
            position: createTilePosition(row, col),
        }));
    }

    for (let index = 0; index < blockEdges.length; index++) {
        const edge = blockEdges[index];
        if (!Object.hasOwn(blockEdges, index) || edge === undefined) {
            throw new RangeError(`missing block edge at index ${index}`);
        }
        if (!Direction.is(edge.direction)) {
            throw new TypeError(`invalid block edge direction at index ${index}`);
        }
        if (!["NONE", "WALK_ONLY", "FLY_ONLY", "ALL"].includes(edge.blockMask)) {
            throw new TypeError(`invalid block edge mask at index ${index}`);
        }
        if (!Array.isArray(edge.position) || edge.position.length !== 2) {
            throw new RangeError(`invalid block edge position at index ${index}`);
        }
        const position = createTilePosition(edge.position[0], edge.position[1]);
        const [dRow, dCol] = Direction.vector(edge.direction);
        const neighbor = createTilePosition(position[0] + dRow, position[1] + dCol);
        if (!BattlefieldMap.contains(map, position) && !BattlefieldMap.contains(map, neighbor)) {
            throw new RangeError(`block edge at index ${index} has no endpoint inside the map`);
        }
        copiedBlockEdges.push(Object.freeze({
            position,
            direction: edge.direction,
            blockMask: edge.blockMask,
        }));
    }

    Object.freeze(copiedTiles);
    Object.freeze(copiedMarkers);
    Object.freeze(copiedBlockEdges);
    return Object.freeze(map);
}
