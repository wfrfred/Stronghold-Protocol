import { Tile, type TilePosition } from "../../geometry/coordinate.js";
import { Direction } from "../../geometry/direction.js";
import { BattlefieldMap } from "../../map/map.js";
import type { PassableMask } from "../../map/tile.js";
import { createNavigationMap, PathMotionMode } from "../../navigation/map.js";
import type { NavigationCell, NavigationMap, NavigationRevision } from "../../navigation/map.js";

export interface WordTileCost {
    readonly position: TilePosition;
    readonly moveCost: number;
}

function includesMode(mask: PassableMask, mode: PathMotionMode): boolean {
    return mask === "ALL" || mask === (mode === "WALK" ? "WALK_ONLY" : "FLY_ONLY");
}

export function projectStaticNavigationMap(
    map: BattlefieldMap,
    pathMotionMode: PathMotionMode,
    revision: NavigationRevision,
    wordTileCosts: readonly WordTileCost[] = [],
): NavigationMap {
    if (!PathMotionMode.is(pathMotionMode)) {
        throw new TypeError("invalid path motion mode");
    }
    const costs = new Map<number, number>();
    for (let index = 0; index < wordTileCosts.length; index++) {
        const cost = wordTileCosts[index];
        if (!Object.hasOwn(wordTileCosts, index) || cost === undefined) {
            throw new RangeError(`missing word tile cost at index ${index}`);
        }
        const tile = BattlefieldMap.get(map, cost.position);
        if (tile === undefined || tile.terrain !== "WORD") {
            throw new RangeError("word tile cost must refer to a word tile");
        }
        if (!Number.isInteger(cost.moveCost) || cost.moveCost <= 0 || cost.moveCost > 0x7fffffff) {
            throw new RangeError("invalid word tile cost");
        }
        const key = cost.position[0] * map.columns + cost.position[1];
        if (costs.has(key)) {
            throw new RangeError("duplicate word tile cost");
        }
        costs.set(key, cost.moveCost);
    }

    const cells: NavigationCell[] = map.tiles.map((tile, index) => {
        let moveCost = 1;
        if (pathMotionMode === "WALK") {
            if (tile.terrain === "HOLE") {
                moveCost = 1_000_000;
            } else if (tile.terrain === "WORD") {
                const mechanismCost = costs.get(index);
                if (mechanismCost === undefined) {
                    throw new RangeError("WALK word tile requires an explicit mechanism cost");
                }
                moveCost = Math.max(1, mechanismCost);
            }
        }
        return {
            passable: includesMode(tile.passableMask, pathMotionMode),
            moveCost,
            departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true },
        };
    });

    for (const edge of map.blockEdges) {
        if (!includesMode(edge.blockMask, pathMotionMode)) {
            continue;
        }
        const adjacent = Tile.translate(edge.position, Direction.vector(edge.direction));
        for (const [position, direction] of [
            [edge.position, edge.direction],
            [adjacent, Direction.opposite(edge.direction)],
        ] as const) {
            if (BattlefieldMap.contains(map, position)) {
                const key = position[0] * map.columns + position[1];
                const cell = cells[key]!;
                const departures = { ...cell.departures };
                departures[direction] = false;
                cells[key] = { ...cell, departures };
            }
        }
    }

    return createNavigationMap({
        rows: map.rows,
        columns: map.columns,
        pathMotionMode,
        revision,
        cells,
    });
}
