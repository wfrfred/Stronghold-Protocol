import { Tile, type TileOffset, type TilePosition } from "./coordinate.js";
import type { Direction } from "./direction.js";

/** Unique integer offsets authored facing RIGHT; uniqueness is guaranteed at construction. */
export type RangeGrid = readonly TileOffset[];

export const RangeGrid = {
    /** Rotates and translates the range, preserving order without clipping to board bounds. */
    project(range: RangeGrid, origin: TilePosition, direction: Direction,): readonly TilePosition[] {
        return range.map(offset => {
            const rotated = Tile.rotate(offset, direction);
            return Tile.translate(origin, rotated);
        });
    }
}
