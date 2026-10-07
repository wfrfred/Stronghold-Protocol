import { World, type TilePosition, type WorldPosition } from "../../geometry/coordinate.js";
import { NavigationMap, type NavigationCell } from "./map.js";

export function navigationSegmentCost(
    map: NavigationMap,
    from: WorldPosition,
    to: WorldPosition,
    acceptCell: (cell: NavigationCell, position: TilePosition) => boolean = () => true,
): number | null {
    let [row, col] = World.toTile(from);
    const [endRow, endCol] = World.toTile(to);

    const clear = (row: number, col: number): boolean => {
        const cell = NavigationMap.get(map, [row, col]);

        return cell !== undefined && cell.passable && acceptCell(cell, [row, col]);
    };

    if (!clear(row, col) || !clear(endRow, endCol)) {
        return null;
    }

    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.abs(dx) + Math.abs(dy);
    const rowStep = Math.sign(dy);
    const colStep = Math.sign(dx);
    const rowDirection = rowStep > 0 ? "UP" : "DOWN";
    const colDirection = colStep > 0 ? "RIGHT" : "LEFT";
    let time = 0;
    let cost = 0;

    while (row !== endRow || col !== endCol) {
        const rowTime = row === endRow ? Infinity : (row + rowStep * 0.5 - from[1]) / dy;
        const colTime = col === endCol ? Infinity : (col + colStep * 0.5 - from[0]) / dx;
        const crossRow = rowTime <= colTime || Math.abs(rowTime - colTime) <= Number.EPSILON;
        const crossCol = colTime <= rowTime || Math.abs(rowTime - colTime) <= Number.EPSILON;
        const nextTime = Math.min(1, Math.max(time, Math.min(rowTime, colTime)));
        cost += (nextTime - time) * length * NavigationMap.get(map, [row, col])!.moveCost;
        time = nextTime;

        if (crossRow && !NavigationMap.canDepart(map, [row, col], rowDirection)) {
            return null;
        }
        if (crossCol && !NavigationMap.canDepart(map, [row, col], colDirection)) {
            return null;
        }
        if (
            crossRow &&
            crossCol &&
            (!clear(row + rowStep, col) ||
                !clear(row, col + colStep) ||
                !NavigationMap.canDepart(map, [row + rowStep, col], colDirection) ||
                !NavigationMap.canDepart(map, [row, col + colStep], rowDirection))
        ) {
            return null;
        }

        if (crossRow) {
            row += rowStep;
        }
        if (crossCol) {
            col += colStep;
        }
        if (!clear(row, col)) {
            return null;
        }
    }

    return cost + (1 - time) * length * NavigationMap.get(map, [row, col])!.moveCost;
}

export function canTraverseNavigationSegment(
    map: NavigationMap,
    from: WorldPosition,
    to: WorldPosition,
): boolean {
    return navigationSegmentCost(map, from, to) !== null;
}

export function canTraverseNavigationRecoverySegment(
    map: NavigationMap,
    from: WorldPosition,
    to: WorldPosition,
): boolean {
    const [minimum, maximum] = NavigationMap.bounds(map);
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

    return canTraverseNavigationSegment(map, clipped(enter), clipped(exit));
}
