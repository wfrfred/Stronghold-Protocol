import type { WorldPosition } from "./coordinate.js";
import type { Range } from "./range.js";
import type { Shape } from "./shape.js";

function containsShape(shape: Shape, origin: WorldPosition, position: WorldPosition): boolean {
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
    circle: Extract<Shape, { readonly type: "CIRCLE" }>,
    circleOrigin: WorldPosition,
    shape: Shape,
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

function overlapsShapes(
    left: Shape,
    leftOrigin: WorldPosition,
    right: Shape,
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

function sweepBox(
    from: WorldPosition,
    to: WorldPosition,
    halfExtents: WorldPosition,
): number | null {
    let first = 0;
    let last = 1;

    for (const axis of [0, 1] as const) {
        const delta = to[axis] - from[axis];
        const extent = halfExtents[axis];

        if (delta === 0) {
            if (Math.abs(from[axis]) > extent) {
                return null;
            }

            continue;
        }

        const enter = (-extent - from[axis]) / delta;
        const exit = (extent - from[axis]) / delta;

        first = Math.max(first, Math.min(enter, exit));
        last = Math.min(last, Math.max(enter, exit));

        if (first > last) {
            return null;
        }
    }

    return first;
}

function sweepCircle(
    from: WorldPosition,
    to: WorldPosition,
    center: WorldPosition,
    radius: number,
): number | null {
    const x = from[0] - center[0];
    const y = from[1] - center[1];

    if (x * x + y * y <= radius * radius) {
        return 0;
    }

    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
        return null;
    }

    const projection = -(x * dx + y * dy);
    const cross = x * dy - y * dx;
    const discriminant = radius * radius * lengthSquared - cross * cross;

    if (discriminant < 0) {
        return null;
    }

    const first = (projection - Math.sqrt(discriminant)) / lengthSquared;

    return first >= 0 && first <= 1 ? first : null;
}

export function contains(range: Range, origin: WorldPosition, point: WorldPosition): boolean {
    return range.some((shape) => containsShape(shape, origin, point));
}

export function overlaps(
    range: Range,
    origin: WorldPosition,
    shape: Shape,
    shapeOrigin: WorldPosition,
): boolean {
    return range.some((entry) => overlapsShapes(entry, origin, shape, shapeOrigin));
}

export function sweep(
    moving: Shape,
    from: WorldPosition,
    to: WorldPosition,
    target: Shape,
    targetOrigin: WorldPosition,
): number | null {
    if (overlapsShapes(moving, from, target, targetOrigin)) {
        return 0;
    }

    if (from[0] === to[0] && from[1] === to[1]) {
        return null;
    }

    const x = targetOrigin[0] + target.offset[0];
    const y = targetOrigin[1] + target.offset[1];
    const start: WorldPosition = [from[0] + moving.offset[0] - x, from[1] + moving.offset[1] - y];
    const end: WorldPosition = [to[0] + moving.offset[0] - x, to[1] + moving.offset[1] - y];
    const width =
        (moving.type === "BOX" ? moving.halfExtents[0] : 0) +
        (target.type === "BOX" ? target.halfExtents[0] : 0);
    const height =
        (moving.type === "BOX" ? moving.halfExtents[1] : 0) +
        (target.type === "BOX" ? target.halfExtents[1] : 0);
    const radius =
        (moving.type === "CIRCLE" ? moving.radius : 0) +
        (target.type === "CIRCLE" ? target.radius : 0);

    if (radius === 0) {
        return sweepBox(start, end, [width, height]);
    }

    if (width === 0 && height === 0) {
        return sweepCircle(start, end, [0, 0], radius);
    }

    const horizontal = sweepBox(start, end, [width + radius, height]);
    const vertical = sweepBox(start, end, [width, height + radius]);
    let first = horizontal;

    if (vertical !== null && (first === null || vertical < first)) {
        first = vertical;
    }

    for (const cx of [-width, width]) {
        for (const cy of [-height, height]) {
            const contact = sweepCircle(start, end, [cx, cy], radius);

            if (contact !== null && (first === null || contact < first)) {
                first = contact;
            }
        }
    }

    return first;
}
