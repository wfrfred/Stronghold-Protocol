import { createTile, type PassableMask, type Tile } from "./tile.js";
import { assertPositiveSafeInteger } from "../../../common/assert.js";
import { createTilePosition, type TilePosition } from "../../geometry/coordinate.js";
import { Direction } from "../../geometry/direction.js";

export interface BattlefieldMarker {
    readonly type: "START" | "END" | "TELEPORT_IN" | "TELEPORT_OUT";
    readonly position: TilePosition;
}

export interface BattlefieldBlockEdge {
    readonly position: TilePosition;
    readonly direction: Direction;
    readonly blockMask: PassableMask;
}

interface Fields {
    readonly rows: number;
    readonly columns: number;
    readonly tiles: readonly Tile[];
    readonly markers: readonly BattlefieldMarker[];
    readonly blockEdges: readonly BattlefieldBlockEdge[];
}

declare const created: unique symbol;

export interface BattlefieldMap extends Fields {
    readonly [created]: true;
}

function contains(map: Fields, position: TilePosition): boolean {
    const [row, col] = position;

    return row >= 0 && row < map.rows && col >= 0 && col < map.columns;
}

export const BattlefieldMap = {
    contains(map: BattlefieldMap, position: TilePosition): boolean {
        return contains(map, position);
    },

    get(map: BattlefieldMap, position: TilePosition): Tile | undefined {
        if (!BattlefieldMap.contains(map, position)) {
            return undefined;
        }

        const [row, col] = position;

        return map.tiles[row * map.columns + col];
    },
};

export function createBattlefieldMap(
    rows: number,
    columns: number,
    tiles: readonly Tile[],
    markers: readonly BattlefieldMarker[] = [],
    blockEdges: readonly BattlefieldBlockEdge[] = [],
): BattlefieldMap {
    assertPositiveSafeInteger(rows, "battlefield row count");
    assertPositiveSafeInteger(columns, "battlefield column count");

    const tileCount = rows * columns;

    if (!Number.isSafeInteger(tileCount) || tileCount > 0xffff_ffff) {
        throw new RangeError("map dimensions exceed the supported array length");
    }

    if (tiles.length !== tileCount) {
        throw new RangeError(`expected ${rows * columns} tiles, got ${tiles.length}`);
    }

    const copiedTiles: Tile[] = [];

    for (let index = 0; index < tiles.length; index++) {
        if (!Object.hasOwn(tiles, index)) {
            throw new RangeError(`missing tile at index ${index}`);
        }

        copiedTiles.push(createTile(tiles[index]!));
    }

    const copiedMarkers: BattlefieldMarker[] = [];
    const copiedBlockEdges: BattlefieldBlockEdge[] = [];
    const map: Fields = {
        rows,
        columns,
        tiles: copiedTiles,
        markers: copiedMarkers,
        blockEdges: copiedBlockEdges,
    };

    for (let index = 0; index < markers.length; index++) {
        if (!Object.hasOwn(markers, index)) {
            throw new RangeError(`missing marker at index ${index}`);
        }

        const marker = markers[index]!;
        const position = createTilePosition(marker.position[0], marker.position[1]);

        if (!contains(map, position)) {
            throw new RangeError(`marker at index ${index} is outside the map`);
        }

        copiedMarkers.push(
            Object.freeze({
                type: marker.type,
                position,
            }),
        );
    }

    for (let index = 0; index < blockEdges.length; index++) {
        if (!Object.hasOwn(blockEdges, index)) {
            throw new RangeError(`missing block edge at index ${index}`);
        }

        const edge = blockEdges[index]!;

        const position = createTilePosition(edge.position[0], edge.position[1]);
        const [dRow, dCol] = Direction.vector(edge.direction);
        const neighbor = createTilePosition(position[0] + dRow, position[1] + dCol);

        if (!contains(map, position) && !contains(map, neighbor)) {
            throw new RangeError(`block edge at index ${index} has no endpoint inside the map`);
        }

        copiedBlockEdges.push(
            Object.freeze({
                position,
                direction: edge.direction,
                blockMask: edge.blockMask,
            }),
        );
    }

    Object.freeze(copiedTiles);
    Object.freeze(copiedMarkers);
    Object.freeze(copiedBlockEdges);

    return Object.freeze(map) as BattlefieldMap;
}
