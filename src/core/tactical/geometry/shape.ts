import { createWorldOffset, type WorldOffset } from "./coordinate.js";
import { Direction } from "./direction.js";
import { RangeGrid } from "./range.js";

export type LocalShape =
    | {
          readonly type: "CIRCLE";
          readonly offset: WorldOffset;
          readonly radius: number;
      }
    | {
          readonly type: "BOX";
          readonly offset: WorldOffset;
          readonly halfExtents: readonly [halfWidth: number, halfHeight: number];
      };

export interface ShapeGeometry {
    readonly shapes: readonly [LocalShape, ...LocalShape[]];
}

export type HitGeometry = ShapeGeometry;

export interface BlockGeometry {
    readonly radius: number;
}

export type RangeGeometry =
    | {
          readonly type: "SHAPES";
          readonly geometry: ShapeGeometry;
      }
    | {
          readonly type: "GRID";
          readonly offsets: RangeGrid;
          readonly direction: Direction;
      };

const ownedShapes = new WeakSet<ShapeGeometry>();
const ownedBlocks = new WeakSet<BlockGeometry>();
const ownedRanges = new WeakSet<RangeGeometry>();

function requireNonnegative(value: number, name: string): number {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be finite and nonnegative`);
    }

    return value;
}

function createLocalShape(shape: LocalShape): LocalShape {
    const offset = createWorldOffset(shape.offset[0], shape.offset[1]);

    switch (shape.type) {
        case "CIRCLE":
            return Object.freeze({
                type: shape.type,
                offset,
                radius: requireNonnegative(shape.radius, "circle radius"),
            });

        case "BOX": {
            const halfExtents: readonly [halfWidth: number, halfHeight: number] = Object.freeze([
                requireNonnegative(shape.halfExtents[0], "box half width"),
                requireNonnegative(shape.halfExtents[1], "box half height"),
            ]);

            return Object.freeze({ type: shape.type, offset, halfExtents });
        }
    }
}

export function createShapeGeometry(geometry: ShapeGeometry): ShapeGeometry {
    if (ownedShapes.has(geometry)) {
        return geometry;
    }
    if (geometry.shapes.length === 0) {
        throw new RangeError("shape geometry must contain at least one shape");
    }

    const shapes: LocalShape[] = [];

    for (let index = 0; index < geometry.shapes.length; index++) {
        if (!Object.hasOwn(geometry.shapes, index)) {
            throw new RangeError("shape geometry must be dense");
        }

        shapes.push(createLocalShape(geometry.shapes[index]!));
    }

    const owned = Object.freeze({
        shapes: Object.freeze(shapes) as readonly [LocalShape, ...LocalShape[]],
    });

    ownedShapes.add(owned);

    return owned;
}

export function createBlockGeometry(geometry: BlockGeometry): BlockGeometry {
    if (ownedBlocks.has(geometry)) {
        return geometry;
    }

    const owned = Object.freeze({ radius: requireNonnegative(geometry.radius, "block radius") });

    ownedBlocks.add(owned);

    return owned;
}

export function createRangeGeometry(range: RangeGeometry): RangeGeometry {
    if (ownedRanges.has(range)) {
        return range;
    }

    let owned: RangeGeometry;

    switch (range.type) {
        case "SHAPES":
            owned = Object.freeze({
                type: range.type,
                geometry: createShapeGeometry(range.geometry),
            });
            break;

        case "GRID":
            if (!Direction.is(range.direction)) {
                throw new TypeError("range direction must be cardinal");
            }

            owned = Object.freeze({
                type: range.type,
                offsets: RangeGrid.create(range.offsets),
                direction: range.direction,
            });
            break;
    }

    ownedRanges.add(owned);

    return owned;
}
