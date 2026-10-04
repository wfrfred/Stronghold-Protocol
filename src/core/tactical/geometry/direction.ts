import type { TileOffset } from "./coordinate.js";

export const DIRECTIONS = [
    "UP",
    "RIGHT",
    "DOWN",
    "LEFT",
] as const;

export type Direction = typeof DIRECTIONS[number];

const DIRECTION_VECTOR = {
    UP: [1, 0],
    RIGHT: [0, 1],
    DOWN: [-1, 0],
    LEFT: [0, -1],
} as const satisfies Record<Direction, TileOffset>;

const OPPOSITE_DIRECTION = {
    UP: "DOWN",
    DOWN: "UP",
    LEFT: "RIGHT",
    RIGHT: "LEFT"
} as const satisfies Record<Direction, Direction>;

const MIRROR_DIRECTION = {
    UP: "UP",
    DOWN: "DOWN",
    LEFT: "RIGHT",
    RIGHT: "LEFT"
} as const satisfies Record<Direction, Direction>;

export const Direction = {
    vector(direction: Direction): TileOffset {
        return DIRECTION_VECTOR[direction];
    },

    opposite(direction: Direction): Direction {
        return OPPOSITE_DIRECTION[direction];
    },

    /** Left-right reflection; UP and DOWN stay unchanged. */
    mirror(direction: Direction): Direction {
        return MIRROR_DIRECTION[direction];
    },

    is(value: unknown): value is Direction {
        return typeof value === "string" && DIRECTIONS.includes(value as Direction);
    }
}
