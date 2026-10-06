import { Direction, DIRECTIONS } from "../geometry/direction.js";
import type { NavigationField, NavigationFieldNode, NavigationFieldQuery } from "./field.js";
import { NavigationMap } from "./map.js";
import { smoothNavigationField } from "./smoothing.js";

export function buildRawNavigationField(
    map: NavigationMap,
    query: NavigationFieldQuery,
): NavigationField {
    const targetTile = Object.freeze([query.targetTile[0], query.targetTile[1]] as const);

    if (!NavigationMap.contains(map, targetTile)) {
        throw new RangeError("navigation field target is outside the map");
    }

    const count = map.cells.length;
    const distances = new Array<number>(count).fill(-1);
    const successors = new Array<number>(count).fill(-1);
    const inQueue = new Array<boolean>(count).fill(false);
    const queue = new Array<number>(count);
    let head = 0;
    let tail = 0;
    let queued = 0;

    const enqueue = (index: number): void => {
        queue[tail] = index;
        tail = (tail + 1) % count;
        queued++;
        inQueue[index] = true;
    };

    const targetIndex = targetTile[0] * map.columns + targetTile[1];

    if (map.cells[targetIndex]!.passable) {
        distances[targetIndex] = 0;
        enqueue(targetIndex);
    }

    while (queued > 0) {
        const current = queue[head]!;
        head = (head + 1) % count;
        queued--;
        inQueue[current] = false;

        const row = Math.floor(current / map.columns);
        const col = current % map.columns;

        for (const direction of DIRECTIONS) {
            const [dRow, dCol] = Direction.vector(direction);
            const neighborRow = row + dRow;
            const neighborCol = col + dCol;

            if (
                neighborRow < 0 ||
                neighborRow >= map.rows ||
                neighborCol < 0 ||
                neighborCol >= map.columns
            ) {
                continue;
            }

            const neighbor = neighborRow * map.columns + neighborCol;
            const cell = map.cells[neighbor]!;

            if (!cell.passable || !cell.departures[Direction.opposite(direction)]) {
                continue;
            }

            const candidate = distances[current]! + cell.moveCost;

            if (candidate > 0x7fffffff) {
                throw new RangeError("navigation field distance exceeds int32 range");
            }
            if (distances[neighbor]! >= 0 && candidate >= distances[neighbor]!) {
                continue;
            }

            distances[neighbor] = candidate;
            successors[neighbor] = current;

            if (!inQueue[neighbor]) {
                enqueue(neighbor);
            }
        }
    }

    const nodes: NavigationFieldNode[] = distances.map((distance, index) => {
        if (distance < 0) {
            return Object.freeze({ type: "UNREACHABLE" });
        }
        if (index === targetIndex) {
            return Object.freeze({ type: "TARGET", distance: 0 });
        }

        const successor = successors[index]!;
        const next = Object.freeze([
            Math.floor(successor / map.columns),
            successor % map.columns,
        ] as const);

        return Object.freeze({ type: "REACHABLE", distance, rawNext: next, next });
    });

    return Object.freeze({
        map,
        query: Object.freeze({ targetTile, allowDiagonalMove: query.allowDiagonalMove }),
        nodes: Object.freeze(nodes),
    });
}

export function buildNavigationField(
    map: NavigationMap,
    query: NavigationFieldQuery,
): NavigationField {
    return smoothNavigationField(buildRawNavigationField(map, query));
}
