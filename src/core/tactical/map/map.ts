import type { Tile } from "./tile.js";
import type { TilePosition } from "../geometry/coordinate.js";

export interface TileMap {
    readonly rows: number;
    readonly columns: number;
    readonly tiles: readonly Tile[];
}

export const TileMap = {
    contains(map: TileMap, position: TilePosition): boolean {
        const [row, col] = position;

        if (!Number.isInteger(row) || !Number.isInteger(col)) {
            throw new RangeError(`non-integer tile position: [${row}, ${col}]`);
        }

        return row >= 0 && row < map.rows &&
            col >= 0 && col < map.columns;
    },

    get(map: TileMap, position: TilePosition): Tile | undefined {
        if (!TileMap.contains(map, position)) {
            return undefined;
        }

        const [row, col] = position;
        return map.tiles[row * map.columns + col];
    }
};

export function createTileMap(
    rows: number,
    columns: number,
    tiles: readonly Tile[],
): TileMap {
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

    return {
        rows,
        columns,
        tiles: [...tiles],
    };
}