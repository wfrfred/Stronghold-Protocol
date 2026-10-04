import { Direction } from "./direction.js";

/** Row increases upward; col increases rightward. */
export type TilePosition = readonly [
    row: number,
    col: number,
];

export type TileOffset = readonly [
    dRow: number,
    dCol: number,
];

/** X increases rightward; y increases upward. */
export type WorldPosition = readonly [
    x: number,
    y: number,
];

export type WorldOffset = readonly [
    dx: number,
    dy: number,
];

export const Tile = {
    translate(position: TilePosition, offset: TileOffset): TilePosition {
        return [position[0] + offset[0], position[1] + offset[1],];
    },

    /** @returns a - b: the offset from b to a. */
    difference(a: TilePosition, b: TilePosition,): TileOffset {
        return [a[0] - b[0], a[1] - b[1],];
    },

    /** Rotates a local offset authored facing RIGHT into board coordinates. */
    rotate(offset: TileOffset, direction: Direction): TileOffset {
        const [dRow, dCol] = offset;
        const [fr, fc] = Direction.vector(direction);

        const row = dRow * fc + dCol * fr;
        const col = -dRow * fr + dCol * fc;

        return [
            row === 0 ? 0 : row,
            col === 0 ? 0 : col,
        ];
    }
}
