import {
    assertFiniteNumber,
    assertNonnegativeNumber,
    assertSafeInteger,
} from "../../common/assert.js";
import { Direction } from "./direction.js";

export type TilePosition = readonly [row: number, col: number];

export type WorldPosition = readonly [x: number, y: number];

export function isTilePosition(value: unknown): value is TilePosition {
    return (
        Array.isArray(value) &&
        value.length === 2 &&
        Object.hasOwn(value, 0) &&
        Object.hasOwn(value, 1) &&
        Number.isSafeInteger(value[0]) &&
        Number.isSafeInteger(value[1])
    );
}

export function isWorldPosition(value: unknown): value is WorldPosition {
    return (
        Array.isArray(value) &&
        value.length === 2 &&
        Object.hasOwn(value, 0) &&
        Object.hasOwn(value, 1) &&
        Number.isFinite(value[0]) &&
        Number.isFinite(value[1])
    );
}

function roundTiesToEven(value: number): number {
    assertFiniteNumber(value, "world coordinate");

    const lower = Math.floor(value);
    const fraction = value - lower;

    if (fraction < 0.5) {
        return lower;
    }
    if (fraction > 0.5) {
        return lower + 1;
    }

    return lower % 2 === 0 ? lower : lower + 1;
}

export function createTilePosition(row: number, col: number): TilePosition {
    assertSafeInteger(row, "row");
    assertSafeInteger(col, "col");

    return [row, col];
}

export function createWorldPosition(x: number, y: number): WorldPosition {
    assertFiniteNumber(x, "x");
    assertFiniteNumber(y, "y");

    return [x, y];
}

export const Tile = {
    add(a: TilePosition, b: TilePosition): TilePosition {
        return createTilePosition(a[0] + b[0], a[1] + b[1]);
    },

    sub(a: TilePosition, b: TilePosition): TilePosition {
        return createTilePosition(a[0] - b[0], a[1] - b[1]);
    },

    rotate(vector: TilePosition, direction: Direction): TilePosition {
        const [dRow, dCol] = vector;
        const [forwardRow, forwardCol] = Direction.vector(direction);

        const row = dRow * forwardCol + dCol * forwardRow;
        const col = -dRow * forwardRow + dCol * forwardCol;

        return createTilePosition(row, col);
    },

    center(position: TilePosition): WorldPosition {
        return createWorldPosition(position[1], position[0]);
    },
};

export const World = {
    add(a: WorldPosition, b: WorldPosition): WorldPosition {
        return createWorldPosition(a[0] + b[0], a[1] + b[1]);
    },

    sub(a: WorldPosition, b: WorldPosition): WorldPosition {
        return createWorldPosition(a[0] - b[0], a[1] - b[1]);
    },

    negate(v: WorldPosition): WorldPosition {
        return createWorldPosition(-v[0], -v[1]);
    },

    scale(v: WorldPosition, factor: number): WorldPosition {
        return createWorldPosition(v[0] * factor, v[1] * factor);
    },

    length(v: WorldPosition): number {
        const length = Math.hypot(v[0], v[1]);
        assertFiniteNumber(length, "world length");

        return length;
    },

    distanceSquared(a: WorldPosition, b: WorldPosition): number {
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];

        const distanceSquared = dx * dx + dy * dy;
        assertFiniteNumber(distanceSquared, "squared world distance");

        return distanceSquared;
    },

    clampLength(v: WorldPosition, maxLength: number): WorldPosition {
        assertNonnegativeNumber(maxLength, "maxLength");

        const length = World.length(v);

        return length > maxLength ? World.scale(v, maxLength / length) : v;
    },

    toTile(position: WorldPosition): TilePosition {
        return createTilePosition(roundTiesToEven(position[1]), roundTiesToEven(position[0]));
    },
};
