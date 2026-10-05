import type { Tile } from "./tile.js";
import type { TilePosition } from "../geometry/coordinate.js";

/** A map annotation; spawning, leaking and teleporting are defined by battle rules. */
export interface BattlefieldMarker {
    readonly type: "START" | "END" | "TELEPORT_IN" | "TELEPORT_OUT";
    readonly position: TilePosition;
}

/** Row zero is at the bottom; tiles are indexed by row * columns + col. */
export interface BattlefieldMap {
    readonly rows: number;
    readonly columns: number;
    readonly tiles: readonly Tile[];
    readonly markers: readonly BattlefieldMarker[];
}

export const BattlefieldMap = {
    contains(map: BattlefieldMap, position: TilePosition): boolean {
        const [row, col] = position;

        if (!Number.isInteger(row) || !Number.isInteger(col)) {
            throw new RangeError(`non-integer tile position: [${row}, ${col}]`);
        }

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
): BattlefieldMap {
    if (!Number.isInteger(rows) || rows <= 0) {
        throw new RangeError(`invalid row count: ${rows}`);
    }

    if (!Number.isInteger(columns) || columns <= 0) {
        throw new RangeError(`invalid column count: ${columns}`);
    }

    if (tiles.length !== rows * columns) {
        throw new RangeError(
            `expected ${rows * columns} tiles, got ${tiles.length}`,
        );
    }

    for (let index = 0; index < tiles.length; index++) {
        if (tiles[index] === undefined) {
            throw new RangeError(`missing tile at index ${index}`);
        }
    }

    const copiedMarkers: BattlefieldMarker[] = [];
    const map: BattlefieldMap = {
        rows,
        columns,
        tiles: [...tiles],
        markers: copiedMarkers,
    };

    for (let index = 0; index < markers.length; index++) {
        const marker = markers[index];
        if (marker === undefined) {
            throw new RangeError(`missing marker at index ${index}`);
        }
        if (!BattlefieldMap.contains(map, marker.position)) {
            throw new RangeError(`marker at index ${index} is outside the map`);
        }
        const [row, col] = marker.position;
        copiedMarkers.push({ type: marker.type, position: [row, col] });
    }

    return map;
}
