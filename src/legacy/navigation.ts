import type { TilePosition } from "../core/tactical/geometry/coordinate.js";
import type { Field } from "../core/tactical/battlefield/navigation/field.js";
import { Map as NavigationMap } from "../core/tactical/battlefield/navigation/map.js";
import type { MotionMode } from "../core/tactical/battlefield/navigation/state.js";
import { Direction, DIRECTIONS } from "../core/tactical/geometry/direction.js";
import { build } from "../core/tactical/battlefield/navigation/pathfinding.js";

export interface LegacyGrid {
    readonly rows: number;
    readonly cols: number;
    readonly version: number;
    walkable(row: number, col: number, ignoreObstacles?: boolean): boolean;
    flyPassable(row: number, col: number): boolean;
    isCrate(row: number, col: number): boolean;
}

export interface LegacyNavigationOptions {
    readonly pathMotionMode?: MotionMode;
    readonly ignoreObstacles?: boolean;
}

export interface LegacyFlowField {
    readonly field: Field;
    readonly dest: number;
    readonly dist: readonly number[];
    readonly parent: readonly number[];
    readonly next: readonly number[];
    readonly version: number;
}

interface GridSnapshot {
    readonly version: number;
    readonly maps: Map<string, NavigationMap>;
}

const snapshots = new WeakMap<LegacyGrid, GridSnapshot>();
const fields = new WeakMap<NavigationMap, Map<string, LegacyFlowField>>();

export function navigationMapFromGrid(
    grid: LegacyGrid,
    options: LegacyNavigationOptions = {},
): NavigationMap {
    let snapshot = snapshots.get(grid);

    if (snapshot?.version !== grid.version) {
        snapshot = { version: grid.version, maps: new Map() };
        snapshots.set(grid, snapshot);
    }

    const pathMotionMode = options.pathMotionMode ?? "WALK";
    const ignoreObstacles = options.ignoreObstacles ?? false;
    const key = `${pathMotionMode}:${ignoreObstacles}`;
    const cached = snapshot.maps.get(key);

    if (cached !== undefined) {
        return cached;
    }

    const cells = [];

    for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
            cells.push({
                passable:
                    pathMotionMode === "FLY"
                        ? grid.flyPassable(row, col)
                        : grid.walkable(row, col, ignoreObstacles),
                cost:
                    pathMotionMode === "WALK" && !ignoreObstacles && grid.isCrate(row, col)
                        ? 1000
                        : 1,
                departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true },
            });
        }
    }

    const map = new NavigationMap(grid.rows, grid.cols, cells);
    snapshot.maps.set(key, map);

    return map;
}

export function flowFieldForGrid(
    grid: LegacyGrid,
    targetRow: number,
    targetCol: number,
    options: LegacyNavigationOptions = {},
): LegacyFlowField {
    const map = navigationMapFromGrid(grid, options);
    let mapFields = fields.get(map);

    if (mapFields === undefined) {
        mapFields = new Map();
        fields.set(map, mapFields);
    }

    const key = `${targetRow}:${targetCol}`;
    const cached = mapFields.get(key);

    if (cached !== undefined) {
        return cached;
    }

    const field = build(map, [targetRow, targetCol]);
    const dist: number[] = [];
    const parent: number[] = [];
    const next: number[] = [];

    for (const [index, node] of field.nodes.entries()) {
        dist.push(node === null ? -1 : node.distance);
        const nextPosition = node?.next;

        next.push(nextPosition ? nextPosition[0] * map.columns + nextPosition[1] : -1);
        let successor = -1;

        if (node !== null && node.next !== null) {
            const row = Math.floor(index / map.columns);
            const col = index % map.columns;
            const cell = map.cells[index]!;

            for (const direction of DIRECTIONS) {
                if (!cell.departures[direction]) {
                    continue;
                }

                const [dr, dc] = Direction.vector(direction);
                const position: TilePosition = [row + dr, col + dc];

                if (!map.contains(position)) {
                    continue;
                }

                const adjacent = position[0] * map.columns + position[1];
                const candidate = field.nodes[adjacent];

                if (
                    candidate !== undefined &&
                    candidate !== null &&
                    candidate.distance + cell.cost === node.distance
                ) {
                    successor = adjacent;
                    break;
                }
            }
        }

        parent.push(successor);
    }

    const result = Object.freeze({
        field,
        dest: targetRow * map.columns + targetCol,
        dist: Object.freeze(dist),
        parent: Object.freeze(parent),
        next: Object.freeze(next),
        version: grid.version,
    });
    mapFields.set(key, result);

    return result;
}

export function waypointsForGrid(
    grid: LegacyGrid,
    startRow: number,
    startCol: number,
    targetRow: number,
    targetCol: number,
    options: LegacyNavigationOptions = {},
): readonly TilePosition[] | null {
    const map = navigationMapFromGrid(grid, options);

    if (!map.contains([startRow, startCol]) || !map.contains([targetRow, targetCol])) {
        return null;
    }

    const flow = flowFieldForGrid(grid, targetRow, targetCol, options);
    const start = startRow * map.columns + startCol;

    if (flow.dist[start]! < 0) {
        return null;
    }

    const positions: TilePosition[] = [Object.freeze([startRow, startCol])];
    let current = start;

    while (current !== flow.dest) {
        current = flow.next[current]!;
        positions.push(Object.freeze([Math.floor(current / map.columns), current % map.columns]));
    }

    return Object.freeze(positions);
}
