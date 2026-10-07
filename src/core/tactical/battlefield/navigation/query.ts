import {
    Tile,
    World,
    type TilePosition,
    type WorldOffset,
    type WorldPosition,
} from "../../geometry/coordinate.js";
import { NavigationMap } from "./map.js";
import { isNavigationGoalReached, type NavigationIntent } from "./request.js";
import type {
    NavigationCursorInitialization,
    NavigationPath,
    NavigationPathCursor,
    NavigationPredictionSelection,
    NavigationSelection,
    NavigationVisitHistory,
} from "./path.js";

function sameTile(a: TilePosition, b: TilePosition): boolean {
    return a[0] === b[0] && a[1] === b[1];
}

export function canTraverseNavigationSegment(
    map: NavigationMap,
    from: WorldPosition,
    to: WorldPosition,
): boolean {
    let [row, col] = World.toTile(from);
    const [endRow, endCol] = World.toTile(to);

    if (
        NavigationMap.get(map, [row, col])?.passable !== true ||
        NavigationMap.get(map, [endRow, endCol])?.passable !== true
    ) {
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

        if (crossRow && !NavigationMap.canDepart(map, [row, col], rowDirection)) {
            return false;
        }
        if (crossCol && !NavigationMap.canDepart(map, [row, col], colDirection)) {
            return false;
        }
        if (
            crossRow &&
            crossCol &&
            (!NavigationMap.canDepart(map, [row + rowStep, col], colDirection) ||
                !NavigationMap.canDepart(map, [row, col + colStep], rowDirection))
        ) {
            return false;
        }

        if (crossRow) {
            row += rowStep;
        }
        if (crossCol) {
            col += colStep;
        }
        if (NavigationMap.get(map, [row, col])?.passable !== true) {
            return false;
        }
    }

    return true;
}

function safeNext(path: NavigationPath<NavigationIntent>, tile: TilePosition): TilePosition {
    const index = tile[0] * path.field.map.columns + tile[1];
    const node = path.field.nodes[index]!;

    return node.type === "REACHABLE" ? node.next : tile;
}

function cursorAt(
    path: NavigationPath<NavigationIntent>,
    tile: TilePosition,
    previous?: NavigationPathCursor,
): NavigationPathCursor {
    const isTarget = sameTile(tile, path.request.targetTile);

    if (previous !== undefined) {
        const tracksTile = isTarget
            ? previous.type === "GOAL"
            : previous.type === "FIELD" && sameTile(tile, previous.nextNode);

        if (tracksTile) {
            return previous;
        }
    }

    return isTarget ? { type: "GOAL" } : { type: "FIELD", nextNode: tile };
}

function hasVisited(visits: NavigationVisitHistory, tile: TilePosition): boolean {
    return visits.visitedCenters.some((visited) => sameTile(visited, tile));
}

function visit(visits: NavigationVisitHistory, tile: TilePosition): NavigationVisitHistory {
    return {
        visitedCenters: [...visits.visitedCenters, tile],
    };
}

interface CenterSelection {
    readonly cursor: NavigationPathCursor;
    readonly visits: NavigationVisitHistory;
    readonly target: WorldPosition | null;
}

function selectCenter(
    path: NavigationPath<NavigationIntent>,
    initialCursor: NavigationPathCursor,
    initialVisits: NavigationVisitHistory,
    locator: WorldPosition,
    tile: TilePosition,
): CenterSelection {
    let cursor = initialCursor;
    let visits = initialVisits;

    if (cursor.type === "GOAL" && !sameTile(tile, path.request.targetTile)) {
        cursor = cursorAt(path, safeNext(path, tile), cursor);
    }

    const options = path.request.options;

    if (options.visitEveryTileCenter) {
        if (!hasVisited(visits, tile)) {
            const center = Tile.center(tile);

            if (!World.withinDistance(locator, center, 0.05)) {
                return { cursor, visits, target: center };
            }

            visits = visit(visits, tile);
        }
    } else if (options.visitEveryNodeCenter || options.visitEveryNodeStably) {
        let tracked = cursor.type === "FIELD" ? cursor.nextNode : path.request.targetTile;

        if (!sameTile(tile, tracked)) {
            tracked = safeNext(path, tile);
            cursor = cursorAt(path, tracked, cursor);
        }

        if (options.visitEveryNodeCenter) {
            if (!hasVisited(visits, tracked)) {
                const center = Tile.center(tracked);

                if (!World.withinDistance(locator, center, 0.05)) {
                    return { cursor, visits, target: center };
                }

                visits = visit(visits, tracked);
                cursor = cursorAt(path, safeNext(path, tracked), cursor);
            }
        } else if (NavigationMap.get(path.field.map, tracked)?.passable) {
            const center = Tile.center(tracked);

            if (!World.withinDistance(locator, center, 0.25)) {
                return { cursor, visits, target: center };
            }

            cursor = cursorAt(path, safeNext(path, tracked), cursor);
        }
    }

    return { cursor, visits, target: null };
}

export function initializeNavigationCursor(
    path: NavigationPath<NavigationIntent>,
    position: WorldPosition,
    locatorOffset: WorldOffset,
): NavigationCursorInitialization {
    const tile = World.toTile(World.translate(position, locatorOffset));

    if (!NavigationMap.contains(path.field.map, tile)) {
        return { type: "OUTSIDE_MAP" };
    }

    return { type: "READY", cursor: cursorAt(path, tile) };
}

export function selectNavigationPredictionTarget(
    path: NavigationPath<NavigationIntent>,
    cursor: NavigationPathCursor,
    visits: NavigationVisitHistory,
    position: WorldPosition,
    locatorOffset: WorldOffset,
): NavigationPredictionSelection {
    const locator = World.translate(position, locatorOffset);
    const tile = World.toTile(locator);

    if (!NavigationMap.contains(path.field.map, tile)) {
        return {
            cursor,
            visits,
            decision: { type: "OUTSIDE_MAP" },
        };
    }

    const center = selectCenter(path, cursor, visits, locator, tile);

    return {
        cursor: center.cursor,
        visits: center.visits,
        decision: {
            type: "TARGET",
            target: World.translate(
                center.target ?? path.request.goal.position,
                World.negate(locatorOffset),
            ),
        },
    };
}

export function selectNavigationSteeringTarget(
    path: NavigationPath<NavigationIntent>,
    cursor: NavigationPathCursor,
    visits: NavigationVisitHistory,
    position: WorldPosition,
    locatorOffset: WorldOffset,
): NavigationSelection {
    const locator = World.translate(position, locatorOffset);
    const tile = World.toTile(locator);

    if (!NavigationMap.contains(path.field.map, tile)) {
        return {
            cursor,
            visits,
            decision: { type: "OUTSIDE_MAP" },
        };
    }

    const center = selectCenter(path, cursor, visits, locator, tile);

    if (center.target !== null) {
        return {
            cursor: center.cursor,
            visits: center.visits,
            decision: {
                type: "MOVE",
                target: World.translate(center.target, World.negate(locatorOffset)),
            },
        };
    }

    if (isNavigationGoalReached(path.request, locator)) {
        return {
            cursor: cursorAt(path, path.request.targetTile, center.cursor),
            visits: center.visits,
            decision: { type: "ARRIVED" },
        };
    }

    const map = path.field.map;
    const targetTile = path.request.targetTile;
    const targetNode = path.field.nodes[targetTile[0] * map.columns + targetTile[1]]!;
    const node = path.field.nodes[tile[0] * map.columns + tile[1]]!;

    if (targetNode.type === "UNREACHABLE" || node.type === "UNREACHABLE") {
        return {
            cursor: center.cursor,
            visits: center.visits,
            decision: {
                type: "UNREACHABLE",
                reason:
                    targetNode.type === "UNREACHABLE"
                        ? "TARGET_UNREACHABLE"
                        : "POSITION_UNREACHABLE",
            },
        };
    }

    const next = safeNext(path, tile);
    const target = sameTile(next, targetTile) ? path.request.goal.position : Tile.center(next);

    return {
        cursor: center.cursor,
        visits: center.visits,
        decision: { type: "MOVE", target: World.translate(target, World.negate(locatorOffset)) },
    };
}
