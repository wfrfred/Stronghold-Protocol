import { createTilePosition, isTilePosition } from "../geometry/coordinate.js";
import type { TilePosition } from "../geometry/coordinate.js";
import { NavigationMap } from "./map.js";
import type { NavigationRequest } from "./request.js";

export interface NavigationFieldQuery {
    readonly targetTile: TilePosition;
    readonly allowDiagonalMove: boolean;
}

export type NavigationFieldNode =
    | {
        readonly type: "UNREACHABLE";
    }
    | {
        readonly type: "TARGET";
        readonly distance: 0;
    }
    | {
        readonly type: "REACHABLE";
        readonly distance: number;
        readonly rawNext: TilePosition;
        readonly next: TilePosition;
    };

export interface NavigationField {
    readonly map: NavigationMap;
    readonly query: NavigationFieldQuery;
    readonly nodes: readonly NavigationFieldNode[];
}

export function deriveNavigationFieldQuery(
    request: NavigationRequest,
): NavigationFieldQuery {
    if (!isTilePosition(request.targetTile)) {
        throw new RangeError("navigation target must be a valid tile position");
    }
    const [row, col] = request.targetTile;

    if (typeof request.options.allowDiagonalMove !== "boolean") {
        throw new TypeError("allowDiagonalMove must be explicit");
    }
    return Object.freeze({
        targetTile: createTilePosition(row, col),
        allowDiagonalMove: request.options.allowDiagonalMove,
    });
}

export function createNavigationField(
    map: NavigationMap,
    query: NavigationFieldQuery,
    nodes: readonly NavigationFieldNode[],
): NavigationField {
    if (!isTilePosition(query.targetTile)) {
        throw new RangeError("navigation field target must be a valid tile position");
    }
    const targetTile = createTilePosition(query.targetTile[0], query.targetTile[1]);
    if (!NavigationMap.contains(map, targetTile)) {
        throw new RangeError("navigation field target is outside the map");
    }
    if (typeof query.allowDiagonalMove !== "boolean") {
        throw new TypeError("allowDiagonalMove must be explicit");
    }
    if (!Array.isArray(nodes) || nodes.length !== map.cells.length) {
        throw new RangeError("navigation field nodes must match map dimensions");
    }
    const targetIndex = targetTile[0] * map.columns + targetTile[1];
    const targetPassable = map.cells[targetIndex]!.passable;
    const copied: NavigationFieldNode[] = [];
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (!Object.hasOwn(nodes, index) || node === undefined || node === null) {
            throw new RangeError(`missing field node at index ${index}`);
        }
        switch (node.type) {
            case "UNREACHABLE":
                if (index === targetIndex && targetPassable) {
                    throw new RangeError("passable field target must be seeded");
                }
                copied.push(Object.freeze({ type: "UNREACHABLE" }));
                break;
            case "TARGET":
                if (index !== targetIndex || !targetPassable || node.distance !== 0) {
                    throw new RangeError("invalid field target node");
                }
                copied.push(Object.freeze({ type: "TARGET", distance: 0 }));
                break;
            case "REACHABLE":
                if (!targetPassable || index === targetIndex || !map.cells[index]!.passable
                    || !Number.isInteger(node.distance) || node.distance <= 0 || node.distance > 0x7fffffff) {
                    throw new RangeError(`invalid reachable field node at index ${index}`);
                }
                if (!isTilePosition(node.rawNext) || !isTilePosition(node.next)) {
                    throw new RangeError("field successors must be valid tile positions");
                }
                copied.push(Object.freeze({
                    type: "REACHABLE",
                    distance: node.distance,
                    rawNext: createTilePosition(node.rawNext[0], node.rawNext[1]),
                    next: createTilePosition(node.next[0], node.next[1]),
                }));
                break;
            default:
                throw new TypeError(`invalid field node at index ${index}`);
        }
    }
    for (let index = 0; index < copied.length; index++) {
        const node = copied[index]!;
        if (node.type !== "REACHABLE") {
            continue;
        }
        for (const nextPosition of [node.rawNext, node.next]) {
            if (!NavigationMap.contains(map, nextPosition)) {
                throw new RangeError("field successor is outside the map");
            }
            const next = copied[nextPosition[0] * map.columns + nextPosition[1]]!;
            if (next.type === "UNREACHABLE" || next.distance >= node.distance) {
                throw new RangeError("field successors must decrease distance");
            }
        }
        const row = Math.floor(index / map.columns);
        const col = index % map.columns;
        const dRow = node.rawNext[0] - row;
        const dCol = node.rawNext[1] - col;
        if (Math.abs(dRow) + Math.abs(dCol) !== 1) {
            throw new RangeError("raw field successor must be an adjacent tile");
        }
        const direction = dRow === 1 ? "UP" : dRow === -1 ? "DOWN" : dCol === 1 ? "RIGHT" : "LEFT";
        const next = copied[node.rawNext[0] * map.columns + node.rawNext[1]]!;
        const cell = map.cells[index]!;
        if (!cell.departures[direction] || next.type === "UNREACHABLE"
            || node.distance !== next.distance + cell.moveCost) {
            throw new RangeError("raw field successor does not match its departure cost");
        }
        if (!query.allowDiagonalMove && node.next[0] !== row && node.next[1] !== col) {
            throw new RangeError("non-diagonal successor must share a row or column");
        }
    }
    return Object.freeze({
        map,
        query: Object.freeze({ targetTile, allowDiagonalMove: query.allowDiagonalMove }),
        nodes: Object.freeze(copied),
    });
}
