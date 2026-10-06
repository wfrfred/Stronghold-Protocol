import type { TilePosition } from "../core/tactical/geometry/coordinate.js";
import type { NavigationField } from "../core/tactical/navigation/field.js";
import {
    createNavigationMap,
    NavigationMap,
    type PathMotionMode,
} from "../core/tactical/navigation/map.js";
import { buildNavigationField } from "../core/tactical/navigation/pathfinding.js";

export interface LegacyGrid {
    readonly rows: number;
    readonly cols: number;
    readonly version: number;
    walkable(row: number, col: number, ignoreObstacles?: boolean): boolean;
    flyPassable(row: number, col: number): boolean;
    isCrate(row: number, col: number): boolean;
}

export interface LegacyNavigationOptions {
    readonly pathMotionMode?: PathMotionMode;
    readonly ignoreObstacles?: boolean;
    readonly allowDiagonal?: boolean;
}

export interface LegacyFlowField {
    readonly field: NavigationField;
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
    if (snapshot === undefined || snapshot.version !== grid.version) {
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
                moveCost:
                    pathMotionMode === "WALK" && !ignoreObstacles && grid.isCrate(row, col)
                        ? 1000
                        : 1,
                departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true },
            });
        }
    }
    const map = createNavigationMap({
        rows: grid.rows,
        columns: grid.cols,
        pathMotionMode,
        revision: grid.version,
        cells,
    });
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
    const allowDiagonalMove = options.allowDiagonal ?? true;
    const key = `${targetRow}:${targetCol}:${allowDiagonalMove}`;
    const cached = mapFields.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const field = buildNavigationField(map, {
        targetTile: [targetRow, targetCol],
        allowDiagonalMove,
    });
    const dist: number[] = [],
        parent: number[] = [],
        next: number[] = [];
    for (const node of field.nodes) {
        dist.push(node.type === "UNREACHABLE" ? -1 : node.distance);
        parent.push(
            node.type === "REACHABLE" ? node.rawNext[0] * map.columns + node.rawNext[1] : -1,
        );
        next.push(node.type === "REACHABLE" ? node.next[0] * map.columns + node.next[1] : -1);
    }
    const result = Object.freeze({
        field,
        dest: targetRow * map.columns + targetCol,
        dist: Object.freeze(dist),
        parent: Object.freeze(parent),
        next: Object.freeze(next),
        version: map.revision,
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
    if (
        !NavigationMap.contains(map, [startRow, startCol]) ||
        !NavigationMap.contains(map, [targetRow, targetCol])
    ) {
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
