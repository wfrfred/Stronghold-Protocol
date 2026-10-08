import { Tile, createTileOffset, type TileOffset, type TilePosition } from "./coordinate.js";
import type { Direction } from "./direction.js";

export type RangeGrid = readonly TileOffset[];

const compiledRanges = new WeakSet<RangeGrid>();

export const RangeGrid = {
    create(offsets: readonly TileOffset[]): RangeGrid {
        if (compiledRanges.has(offsets)) {
            return offsets;
        }

        const seen = new Set<string>();
        const snapshot: TileOffset[] = [];

        for (let index = 0; index < offsets.length; index++) {
            if (!Object.hasOwn(offsets, index)) {
                throw new RangeError(`missing range offset at index ${index}`);
            }

            const offset = offsets[index]!;

            if (!Object.hasOwn(offset, 0) || !Object.hasOwn(offset, 1)) {
                throw new RangeError(`missing range coordinate at index ${index}`);
            }

            const copy = createTileOffset(offset[0], offset[1]);
            const key = `${copy[0]},${copy[1]}`;

            if (seen.has(key)) {
                throw new RangeError(`duplicate range offset at index ${index}`);
            }

            seen.add(key);
            snapshot.push(copy);
        }

        const range = Object.freeze(snapshot);

        compiledRanges.add(range);

        return range;
    },

    project(range: RangeGrid, origin: TilePosition, direction: Direction): readonly TilePosition[] {
        return Object.freeze(
            range.map((offset) => {
                const rotated = Tile.rotate(offset, direction);

                return Tile.translate(origin, rotated);
            }),
        );
    },
};
