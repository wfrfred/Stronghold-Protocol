import { Tile, createTileOffset, type TileOffset, type TilePosition } from "./coordinate.js";
import { Direction } from "./direction.js";

export type RangeGrid = readonly TileOffset[];

export const RangeGrid = {
    create(offsets: readonly TileOffset[]): RangeGrid {
        if (!Array.isArray(offsets)) {
            throw new RangeError("range grid must be an array");
        }
        const seen = new Set<string>();
        const snapshot: TileOffset[] = [];
        for (let index = 0; index < offsets.length; index++) {
            const offset = offsets[index];
            if (!Object.hasOwn(offsets, index) || !Array.isArray(offset) || offset.length !== 2
                || !Object.hasOwn(offset, 0) || !Object.hasOwn(offset, 1)) {
                throw new RangeError(`range offset ${index} must contain exactly two coordinates`);
            }
            const copy = createTileOffset(offset[0], offset[1]);
            const key = `${copy[0]},${copy[1]}`;
            if (seen.has(key)) {
                throw new RangeError(`duplicate range offset at index ${index}`);
            }
            seen.add(key);
            snapshot.push(copy);
        }
        return Object.freeze(snapshot);
    },

    project(range: RangeGrid, origin: TilePosition, direction: Direction,): readonly TilePosition[] {
        const snapshot = RangeGrid.create(range);
        Tile.center(origin);
        if (!Direction.is(direction)) {
            throw new RangeError("invalid direction");
        }
        return Object.freeze(snapshot.map(offset => {
            const rotated = Tile.rotate(offset, direction);
            return Tile.translate(origin, rotated);
        }));
    },
};
