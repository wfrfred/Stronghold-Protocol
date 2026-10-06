import { Tile, World } from "../geometry/coordinate.js";
import type { TilePosition, WorldOffset, WorldPosition } from "../geometry/coordinate.js";
import { NavigationMap } from "./map.js";
import { isNavigationGoalReached } from "./request.js";
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

function safeNext(path: NavigationPath, tile: TilePosition): TilePosition {
    const node = path.field.nodes[tile[0] * path.field.map.columns + tile[1]]!;
    return node.type === "REACHABLE" ? node.next : tile;
}

function cursorAt(
    path: NavigationPath,
    tile: TilePosition,
    previous?: NavigationPathCursor,
): NavigationPathCursor {
    const isTarget = sameTile(tile, path.request.targetTile);
    if (previous !== undefined && (isTarget
        ? previous.type === "GOAL"
        : previous.type === "FIELD" && sameTile(tile, previous.nextNode))) {
        return previous;
    }
    return isTarget
        ? { type: "GOAL" }
        : { type: "FIELD", nextNode: tile };
}

function hasVisited(visits: NavigationVisitHistory, tile: TilePosition): boolean {
    return visits.visitedCenters.some(visited => sameTile(visited, tile));
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
    path: NavigationPath,
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
    path: NavigationPath,
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
    path: NavigationPath,
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
            target: World.translate(center.target ?? path.request.goal.position, World.negate(locatorOffset)),
        },
    };
}

export function selectNavigationSteeringTarget(
    path: NavigationPath,
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
            decision: { type: "MOVE", target: World.translate(center.target, World.negate(locatorOffset)) },
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
                reason: targetNode.type === "UNREACHABLE" ? "TARGET_UNREACHABLE" : "POSITION_UNREACHABLE",
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
