import { Tile, type TilePosition } from "./coordinate.js";
import type { Direction } from "./direction.js";
import type { Shape } from "./shape.js";

export type Range = readonly Shape[];

export function fromTiles(tiles: readonly TilePosition[], direction: Direction): Range {
    return tiles.map((tile) => ({
        type: "BOX",
        offset: Tile.center(Tile.rotate(tile, direction)),
        halfExtents: [0.5, 0.5],
    }));
}
