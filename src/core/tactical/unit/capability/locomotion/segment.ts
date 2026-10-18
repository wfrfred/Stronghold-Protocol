import { World, type WorldPosition } from "../../../geometry/coordinate.js";
import type { Map } from "../../../battlefield/navigation/map.js";

export function canTraverse(map: Map, from: WorldPosition, to: WorldPosition): boolean {
    let [row, col] = World.toTile(from);
    const [endRow, endCol] = World.toTile(to);

    const originRow = row;
    const originCol = col;

    const clear = (row: number, col: number): boolean => {
        const cell = map.get([row, col]);

        return (
            cell?.passable === true &&
            (cell.cost < 1000 ||
                (row === originRow && col === originCol) ||
                (row === endRow && col === endCol))
        );
    };

    if (!clear(row, col) || !clear(endRow, endCol)) {
        return false;
    }

    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const rowStep = Math.sign(dy);
    const colStep = Math.sign(dx);
    const rowDirection = rowStep > 0 ? "UP" : "DOWN";
    const colDirection = colStep > 0 ? "RIGHT" : "LEFT";

    while (row !== endRow || col !== endCol) {
        const rowTime = row === endRow ? Infinity : (row + rowStep * 0.5 - from[1]) / dy;
        const colTime = col === endCol ? Infinity : (col + colStep * 0.5 - from[0]) / dx;
        const crossRow = rowTime <= colTime || Math.abs(rowTime - colTime) <= Number.EPSILON;
        const crossCol = colTime <= rowTime || Math.abs(rowTime - colTime) <= Number.EPSILON;

        if (crossRow && !map.get([row, col])!.departures[rowDirection]) {
            return false;
        }
        if (crossCol && !map.get([row, col])!.departures[colDirection]) {
            return false;
        }
        if (
            crossRow &&
            crossCol &&
            (!clear(row + rowStep, col) ||
                !clear(row, col + colStep) ||
                !map.get([row + rowStep, col])!.departures[colDirection] ||
                !map.get([row, col + colStep])!.departures[rowDirection])
        ) {
            return false;
        }

        if (crossRow) {
            row += rowStep;
        }
        if (crossCol) {
            col += colStep;
        }
        if (!clear(row, col)) {
            return false;
        }
    }

    return true;
}

export function canRecover(map: Map, from: WorldPosition, to: WorldPosition): boolean {
    const margin = Number.EPSILON * Math.max(map.rows, map.columns);
    const minimum: WorldPosition = [-0.5 + margin, -0.5 + margin];
    const maximum: WorldPosition = [map.columns - 0.5 - margin, map.rows - 0.5 - margin];
    const delta = World.difference(to, from);
    let enter = 0;
    let exit = 1;

    for (const axis of [0, 1] as const) {
        if (delta[axis] === 0) {
            if (from[axis] < minimum[axis] || from[axis] > maximum[axis]) {
                return true;
            }
        } else {
            const first = (minimum[axis] - from[axis]) / delta[axis];
            const last = (maximum[axis] - from[axis]) / delta[axis];
            enter = Math.max(enter, Math.min(first, last));
            exit = Math.min(exit, Math.max(first, last));
        }
    }

    if (enter > exit) {
        return true;
    }

    const clipped = (time: number): WorldPosition => [
        Math.max(minimum[0], Math.min(maximum[0], from[0] + delta[0] * time)),
        Math.max(minimum[1], Math.min(maximum[1], from[1] + delta[1] * time)),
    ];

    return canTraverse(map, clipped(enter), clipped(exit));
}
