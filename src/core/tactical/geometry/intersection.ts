import { Tile, type WorldPosition } from "./coordinate.js";
import type { HitGeometry, LocalShape, RangeGeometry, ShapeGeometry } from "./shape.js";

function shapeContainsPosition(
    shape: LocalShape,
    origin: WorldPosition,
    position: WorldPosition,
): boolean {
    const dx = Math.abs(position[0] - origin[0] - shape.offset[0]);
    const dy = Math.abs(position[1] - origin[1] - shape.offset[1]);

    switch (shape.type) {
        case "CIRCLE":
            return dx * dx + dy * dy <= shape.radius * shape.radius;

        case "BOX":
            return dx <= shape.halfExtents[0] && dy <= shape.halfExtents[1];
    }
}

function circleOverlapsShape(
    circle: Extract<LocalShape, { readonly type: "CIRCLE" }>,
    circleOrigin: WorldPosition,
    shape: LocalShape,
    shapeOrigin: WorldPosition,
): boolean {
    let dx = Math.abs(circleOrigin[0] + circle.offset[0] - shapeOrigin[0] - shape.offset[0]);
    let dy = Math.abs(circleOrigin[1] + circle.offset[1] - shapeOrigin[1] - shape.offset[1]);
    let radius = circle.radius;

    switch (shape.type) {
        case "CIRCLE":
            radius += shape.radius;
            break;

        case "BOX":
            dx = Math.max(0, dx - shape.halfExtents[0]);
            dy = Math.max(0, dy - shape.halfExtents[1]);
            break;
    }

    return dx * dx + dy * dy <= radius * radius;
}

function shapesOverlap(
    left: LocalShape,
    leftOrigin: WorldPosition,
    right: LocalShape,
    rightOrigin: WorldPosition,
): boolean {
    if (left.type === "CIRCLE") {
        return circleOverlapsShape(left, leftOrigin, right, rightOrigin);
    }
    if (right.type === "CIRCLE") {
        return circleOverlapsShape(right, rightOrigin, left, leftOrigin);
    }

    const dx = Math.abs(leftOrigin[0] + left.offset[0] - rightOrigin[0] - right.offset[0]);
    const dy = Math.abs(leftOrigin[1] + left.offset[1] - rightOrigin[1] - right.offset[1]);

    return (
        dx <= left.halfExtents[0] + right.halfExtents[0] &&
        dy <= left.halfExtents[1] + right.halfExtents[1]
    );
}

function* rangeShapes(range: RangeGeometry): Generator<LocalShape> {
    switch (range.type) {
        case "SHAPES":
            yield* range.geometry.shapes;
            break;

        case "GRID":
            for (const offset of range.offsets) {
                const rotated = Tile.rotate(offset, range.direction);

                yield {
                    type: "BOX",
                    offset: [rotated[1], rotated[0]],
                    halfExtents: [0.5, 0.5],
                };
            }

            break;
    }
}

export function geometryContainsPosition(
    geometry: ShapeGeometry,
    origin: WorldPosition,
    position: WorldPosition,
): boolean {
    return geometry.shapes.some((shape) => shapeContainsPosition(shape, origin, position));
}

export function rangeContainsPosition(
    range: RangeGeometry,
    origin: WorldPosition,
    position: WorldPosition,
): boolean {
    for (const shape of rangeShapes(range)) {
        if (shapeContainsPosition(shape, origin, position)) {
            return true;
        }
    }

    return false;
}

export function rangeOverlapsHit(
    range: RangeGeometry,
    sourcePosition: WorldPosition,
    targetPosition: WorldPosition,
    hitGeometry: HitGeometry,
): boolean {
    for (const shape of rangeShapes(range)) {
        for (const hit of hitGeometry.shapes) {
            if (shapesOverlap(shape, sourcePosition, hit, targetPosition)) {
                return true;
            }
        }
    }

    return false;
}
