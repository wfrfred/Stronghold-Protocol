import { Tile, type TilePosition } from "../geometry/coordinate.js";
import { Direction, DIRECTIONS } from "../geometry/direction.js";
import { BattlefieldMap } from "./map.js";
import type { PassableMask } from "./tile.js";
import { createNavigationMap, PathMotionMode } from "../navigation/map.js";
import type { NavigationCell, NavigationMap, NavigationMaps, NavigationRevision } from "../navigation/map.js";
import type { NavigationEffectDefinition } from "./navigation-effect.js";

export interface ProjectedNavigationEffect {
    readonly definition: NavigationEffectDefinition;
    readonly positions: readonly TilePosition[];
}

export interface NavigationProjection {
    readonly maps: NavigationMaps;
    readonly changedModes: readonly PathMotionMode[];
}

function includesMode(mask: PassableMask, mode: PathMotionMode): boolean {
    return mask === "ALL" || mask === (mode === "WALK" ? "WALK_ONLY" : "FLY_ONLY");
}

export function projectStaticNavigationMap(
    map: BattlefieldMap,
    pathMotionMode: PathMotionMode,
    revision: NavigationRevision,
): NavigationMap {
    if (!PathMotionMode.is(pathMotionMode)) {
        throw new TypeError("invalid path motion mode");
    }
    const cells: NavigationCell[] = map.tiles.map(tile => ({
        passable: includesMode(tile.passableMask, pathMotionMode),
        moveCost: pathMotionMode === "WALK" && tile.terrain === "HOLE" ? 1_000_000 : 1,
        departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true },
    }));

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

function projectCells(
    baseline: NavigationMap,
    effects: readonly ProjectedNavigationEffect[],
): readonly NavigationCell[] {
    const cells = baseline.cells.slice();
    for (const effect of effects) {
        const restriction = effect.definition[baseline.pathMotionMode];
        if (restriction === null) continue;
        for (const position of effect.positions) {
            const index = position[0] * baseline.columns + position[1];
            const cell = cells[index]!;
            let departures = cell.departures;
            for (const direction of restriction.deniedDepartures) {
                if (departures[direction]) {
                    departures = Object.freeze({ ...departures, [direction]: false });
                }
            }
            const passable = cell.passable && !restriction.denyPassage;
            const moveCost = baseline.pathMotionMode === "WALK"
                ? Math.max(cell.moveCost, effect.definition.WALK!.costFloor)
                : 1;
            if (passable !== cell.passable || moveCost !== cell.moveCost || departures !== cell.departures) {
                cells[index] = Object.freeze({ passable, moveCost, departures });
            }
        }
    }
    return Object.freeze(cells);
}

function sameCells(a: readonly NavigationCell[], b: readonly NavigationCell[]): boolean {
    for (let index = 0; index < a.length; index++) {
        const left = a[index]!;
        const right = b[index]!;
        if (left === right) continue;
        if (left.passable !== right.passable || left.moveCost !== right.moveCost
            || DIRECTIONS.some(direction => left.departures[direction] !== right.departures[direction])) {
            return false;
        }
    }
    return true;
}

export function projectNavigationMaps(
    baseline: NavigationMaps,
    effects: readonly ProjectedNavigationEffect[],
    previous: NavigationMaps,
): NavigationProjection {
    const maps: Record<PathMotionMode, NavigationMap> = { WALK: previous.WALK, FLY: previous.FLY };
    const changedModes: PathMotionMode[] = [];
    for (const mode of ["WALK", "FLY"] as const) {
        const base = baseline[mode];
        const current = previous[mode];
        const cells = projectCells(base, effects);
        if (sameCells(cells, current.cells)) continue;
        const revision = current.revision + 1;
        if (!Number.isSafeInteger(revision)) {
            throw new RangeError("navigation revision overflow");
        }
        maps[mode] = Object.freeze({
            rows: base.rows,
            columns: base.columns,
            pathMotionMode: mode,
            revision,
            cells,
        });
        changedModes.push(mode);
    }
    return Object.freeze({
        maps: changedModes.length === 0 ? previous : Object.freeze(maps),
        changedModes: Object.freeze(changedModes),
    });
}
