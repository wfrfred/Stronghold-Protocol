import type { TilePosition } from "../geometry/coordinate.js";
import { Direction } from "../geometry/direction.js";
import type { NavigationField, NavigationFieldNode } from "./field.js";
import { NavigationMap } from "./map.js";

function isClear(field: NavigationField, row: number, col: number): boolean {
    const position: TilePosition = [row, col];

    if (!NavigationMap.contains(field.map, position)) {
        return false;
    }

    const index = row * field.map.columns + col;

    return (
        field.nodes[index]!.type !== "UNREACHABLE" &&
        (field.map.pathMotionMode === "FLY" || field.map.cells[index]!.moveCost < 1000)
    );
}

function raycast(field: NavigationField, from: TilePosition, to: TilePosition): boolean {
    const rowDelta = Math.abs(to[0] - from[0]);
    const colDelta = Math.abs(to[1] - from[1]);
    const swapAxes = rowDelta > colDelta;
    let startMajor = swapAxes ? from[0] : from[1];
    let startMinor = swapAxes ? from[1] : from[0];
    let endMajor = swapAxes ? to[0] : to[1];
    let endMinor = swapAxes ? to[1] : to[0];
    const reversed = startMajor > endMajor;

    if (reversed) {
        [startMajor, endMajor] = [endMajor, startMajor];
        [startMinor, endMinor] = [endMinor, startMinor];
    }

    const majorDelta = endMajor - startMajor;
    const minorDelta = Math.abs(endMinor - startMinor);
    const minorStep = startMinor < endMinor ? 1 : -1;
    const majorDirection: Direction = swapAxes ? "UP" : "RIGHT";
    let minorDirection: Direction;

    if (swapAxes) {
        minorDirection = minorStep === 1 ? "RIGHT" : "LEFT";
    } else {
        minorDirection = minorStep === 1 ? "UP" : "DOWN";
    }

    const position = (major: number, minor: number): TilePosition =>
        swapAxes ? [major, minor] : [minor, major];

    const clear = (major: number, minor: number): boolean => {
        const [row, col] = position(major, minor);

        return isClear(field, row, col);
    };

    const canTraverse = (major: number, minor: number, direction: Direction): boolean => {
        const from = position(major, minor);

        if (!reversed) {
            return NavigationMap.canDepart(field.map, from, direction);
        }

        const [dRow, dCol] = Direction.vector(direction);

        return NavigationMap.canDepart(
            field.map,
            [from[0] + dRow, from[1] + dCol],
            Direction.opposite(direction),
        );
    };

    if (minorDelta <= 1) {
        for (let row = Math.min(from[0], to[0]); row <= Math.max(from[0], to[0]); row++) {
            for (let col = Math.min(from[1], to[1]); col <= Math.max(from[1], to[1]); col++) {
                if (!isClear(field, row, col)) {
                    return false;
                }
            }
        }
    }

    let error = -majorDelta;
    let minor = startMinor;

    for (let major = startMajor; major <= endMajor; major++) {
        if (
            !clear(major, minor) ||
            (major < endMajor && !canTraverse(major, minor, majorDirection))
        ) {
            return false;
        }

        error += 2 * minorDelta;

        if (major < endMajor && error >= 0) {
            const nextMinor = minor + minorStep;

            if (
                !clear(major, nextMinor) ||
                !clear(major + 1, minor) ||
                !canTraverse(major, minor, minorDirection) ||
                !canTraverse(major + 1, minor, minorDirection) ||
                !canTraverse(major, nextMinor, majorDirection)
            ) {
                return false;
            }

            minor = nextMinor;
            error -= 2 * majorDelta;
        }
    }

    return NavigationMap.canDepart(
        field.map,
        to,
        reversed ? Direction.opposite(majorDirection) : majorDirection,
    );
}

export function smoothNavigationField(field: NavigationField): NavigationField {
    const nodes: NavigationFieldNode[] = field.nodes.slice();

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;

        if (node.type !== "REACHABLE") {
            continue;
        }

        const from: TilePosition = [
            Math.floor(index / field.map.columns),
            index % field.map.columns,
        ];
        let next = node.next;

        for (;;) {
            const nextIndex = next[0] * field.map.columns + next[1];
            const cursor = nodes[nextIndex]!;

            if (cursor.type !== "REACHABLE") {
                break;
            }

            const candidate = cursor.next;
            const clear = field.query.allowDiagonalMove
                ? raycast(field, from, candidate)
                : from[0] === candidate[0] || from[1] === candidate[1];

            if (!clear) {
                break;
            }

            next = candidate;
        }

        nodes[index] = Object.freeze({ ...node, next });
    }

    return Object.freeze({
        map: field.map,
        query: field.query,
        nodes: Object.freeze(nodes),
    });
}
