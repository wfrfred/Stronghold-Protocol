import { createTilePosition, type TilePosition } from "../../geometry/coordinate.js";
import { Direction, DIRECTIONS } from "../../geometry/direction.js";
import type { Field, Node } from "./field.js";
import type { Map } from "./map.js";
import { smooth } from "./smoothing.js";

export function build(map: Map, target: TilePosition): Field {
    target = createTilePosition(target[0], target[1]);

    if (!map.contains(target)) {
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

    const targetIndex = target[0] * map.columns + target[1];

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

            const sum = distances[current]! + cell.cost;
            const candidate = sum <= Number.MAX_SAFE_INTEGER ? sum : Infinity;

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

    const nodes: (Node | null)[] = distances.map((distance, index) => {
        if (distance > Number.MAX_SAFE_INTEGER) {
            throw new RangeError("navigation field distance exceeds safe integer range");
        }
        if (distance < 0) {
            return null;
        }
        if (index === targetIndex) {
            return { distance: 0, next: null };
        }

        const successor = successors[index]!;

        return {
            distance,
            next: createTilePosition(Math.floor(successor / map.columns), successor % map.columns),
        };
    });

    smooth(map, nodes);

    for (const node of nodes) {
        if (node !== null) {
            Object.freeze(node);
        }
    }

    return Object.freeze({
        rows: map.rows,
        columns: map.columns,
        target,
        nodes: Object.freeze(nodes),
    });
}
