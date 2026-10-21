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

function segmentOverlapsBox(
    from: WorldPosition,
    to: WorldPosition,
    halfExtents: readonly [number, number],
): boolean {
    let first = 0;
    let last = 1;

    for (const axis of [0, 1] as const) {
        const delta = to[axis] - from[axis];
        const extent = halfExtents[axis];

        if (delta === 0) {
            if (Math.abs(from[axis]) > extent) {
                return false;
            }

            continue;
        }

        const enter = (-extent - from[axis]) / delta;
        const exit = (extent - from[axis]) / delta;

        first = Math.max(first, Math.min(enter, exit));
        last = Math.min(last, Math.max(enter, exit));

        if (first > last) {
            return false;
        }
    }

    return true;
}

function segmentOverlapsCircle(
    from: WorldPosition,
    to: WorldPosition,
    center: WorldPosition,
    radius: number,
): boolean {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const lengthSquared = dx * dx + dy * dy;
    const projection = (center[0] - from[0]) * dx + (center[1] - from[1]) * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, projection / lengthSquared));
    const x = from[0] + t * dx - center[0];
    const y = from[1] + t * dy - center[1];

    return x * x + y * y <= radius * radius;
}

function shapesSweep(
    shape: LocalShape,
    from: WorldPosition,
    to: WorldPosition,
    hit: LocalShape,
    targetPosition: WorldPosition,
): boolean {
    const x = shape.offset[0] - targetPosition[0] - hit.offset[0];
    const y = shape.offset[1] - targetPosition[1] - hit.offset[1];
    const start: WorldPosition = [from[0] + x, from[1] + y];
    const end: WorldPosition = [to[0] + x, to[1] + y];
    const width =
        (shape.type === "BOX" ? shape.halfExtents[0] : 0) +
        (hit.type === "BOX" ? hit.halfExtents[0] : 0);
    const height =
        (shape.type === "BOX" ? shape.halfExtents[1] : 0) +
        (hit.type === "BOX" ? hit.halfExtents[1] : 0);
    const radius =
        (shape.type === "CIRCLE" ? shape.radius : 0) + (hit.type === "CIRCLE" ? hit.radius : 0);

    if (
        segmentOverlapsBox(start, end, [width + radius, height]) ||
        segmentOverlapsBox(start, end, [width, height + radius])
    ) {
        return true;
    }

    for (const cx of [-width, width]) {
        for (const cy of [-height, height]) {
            if (segmentOverlapsCircle(start, end, [cx, cy], radius)) {
                return true;
            }
        }
    }

    return false;
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

export function geometrySweepsHit(
    geometry: ShapeGeometry,
    from: WorldPosition,
    to: WorldPosition,
    targetPosition: WorldPosition,
    hitGeometry: HitGeometry,
): boolean {
    return geometry.shapes.some((shape) =>
        hitGeometry.shapes.some((hit) => shapesSweep(shape, from, to, hit, targetPosition)),
    );
}
