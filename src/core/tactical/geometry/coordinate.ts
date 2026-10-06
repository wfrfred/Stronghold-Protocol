import { Direction } from "./direction.js";

export type TilePosition = readonly [
    row: number,
    col: number,
];

export type TileOffset = readonly [
    dRow: number,
    dCol: number,
];

export type WorldPosition = readonly [
    x: number,
    y: number,
];

export type WorldOffset = readonly [
    dx: number,
    dy: number,
];

export function isTilePosition(value: unknown): value is TilePosition {
    return Array.isArray(value)
        && value.length === 2
        && Object.hasOwn(value, 0)
        && Object.hasOwn(value, 1)
        && Number.isSafeInteger(value[0])
        && Number.isSafeInteger(value[1]);
}

export function isWorldPosition(value: unknown): value is WorldPosition {
    return Array.isArray(value)
        && value.length === 2
        && Object.hasOwn(value, 0)
        && Object.hasOwn(value, 1)
        && Number.isFinite(value[0])
        && Number.isFinite(value[1]);
}

function requireFinite(value: number, name: string): number {
    if (!Number.isFinite(value)) {
        throw new RangeError(`${name} must be finite`);
    }
    return value === 0 ? 0 : value;
}

function requireSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value)) {
        throw new RangeError(`${name} must be a safe integer`);
    }
    return value === 0 ? 0 : value;
}

function requirePair(value: readonly [number, number], name: string): void {
    if (!Array.isArray(value) || value.length !== 2 || !Object.hasOwn(value, 0) || !Object.hasOwn(value, 1)) {
        throw new RangeError(`${name} must contain exactly two coordinates`);
    }
}

function requireTilePair(value: readonly [number, number], name: string): void {
    requirePair(value, name);
    requireSafeInteger(value[0], `${name}[0]`);
    requireSafeInteger(value[1], `${name}[1]`);
}

function roundTiesToEven(value: number): number {
    requireFinite(value, "world coordinate");
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
    return Object.freeze([
        requireSafeInteger(row, "row"),
        requireSafeInteger(col, "col"),
    ]);
}

export function createTileOffset(dRow: number, dCol: number): TileOffset {
    return Object.freeze([
        requireSafeInteger(dRow, "dRow"),
        requireSafeInteger(dCol, "dCol"),
    ]);
}

export function createWorldPosition(x: number, y: number): WorldPosition {
    return Object.freeze([
        requireFinite(x, "x"),
        requireFinite(y, "y"),
    ]);
}

export function createWorldOffset(dx: number, dy: number): WorldOffset {
    return Object.freeze([
        requireFinite(dx, "dx"),
        requireFinite(dy, "dy"),
    ]);
}

export const Tile = {
    translate(position: TilePosition, offset: TileOffset): TilePosition {
        requireTilePair(position, "tile position");
        requireTilePair(offset, "tile offset");
        return createTilePosition(position[0] + offset[0], position[1] + offset[1]);
    },

    difference(a: TilePosition, b: TilePosition,): TileOffset {
        requireTilePair(a, "tile position");
        requireTilePair(b, "tile position");
        return createTileOffset(a[0] - b[0], a[1] - b[1]);
    },

    rotate(offset: TileOffset, direction: Direction): TileOffset {
        requireTilePair(offset, "tile offset");
        const [dRow, dCol] = offset;
        const [fr, fc] = Direction.vector(direction);

        const row = dRow * fc + dCol * fr;
        const col = -dRow * fr + dCol * fc;

        return createTileOffset(row, col);
    },

    center(position: TilePosition): WorldPosition {
        requireTilePair(position, "tile position");
        return createWorldPosition(position[1], position[0]);
    },
};

export const World = {
    toTile(position: WorldPosition): TilePosition {
        requirePair(position, "world position");
        return createTilePosition(
            roundTiesToEven(position[1]),
            roundTiesToEven(position[0]),
        );
    },
};
