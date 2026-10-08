import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { Tile, type TilePosition } from "../../geometry/coordinate.js";
import { Direction, DIRECTIONS } from "../../geometry/direction.js";
import { BattlefieldMap } from "../map/map.js";
import type { PassableMask } from "../map/tile.js";
import type {
    PathMotionMode,
    NavigationCell,
    NavigationMap,
    NavigationMaps,
    NavigationRevision,
} from "./map.js";
import type { NavigationEffectDefinition } from "./effect.js";

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
    assertNonnegativeSafeInteger(revision, "navigation revision");

    const cells: NavigationCell[] = map.tiles.map((tile) => ({
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
                const index = position[0] * map.columns + position[1];
                const cell = cells[index]!;
                const departures = { ...cell.departures };

                departures[direction] = false;
                cells[index] = { ...cell, departures };
            }
        }
    }

    return Object.freeze({
        rows: map.rows,
        columns: map.columns,
        pathMotionMode,
        revision,
        cells: Object.freeze(
            cells.map((cell) =>
                Object.freeze({ ...cell, departures: Object.freeze(cell.departures) }),
            ),
        ),
    });
}

function projectCells(
    baseline: NavigationMap,
    effects: readonly ProjectedNavigationEffect[],
): readonly NavigationCell[] {
    const cells = baseline.cells.slice();

    for (const effect of effects) {
        const restriction = effect.definition[baseline.pathMotionMode];

        if (restriction === null) {
            continue;
        }

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
            const moveCost =
                baseline.pathMotionMode === "WALK"
                    ? Math.max(cell.moveCost, effect.definition.WALK!.costFloor)
                    : 1;

            if (
                passable !== cell.passable ||
                moveCost !== cell.moveCost ||
                departures !== cell.departures
            ) {
                cells[index] = Object.freeze({ passable, moveCost, departures });
            }
        }
    }

    return Object.freeze(cells);
}

function sameCells(
    leftCells: readonly NavigationCell[],
    rightCells: readonly NavigationCell[],
): boolean {
    for (let index = 0; index < leftCells.length; index++) {
        const left = leftCells[index]!;
        const right = rightCells[index]!;

        if (left === right) {
            continue;
        }

        if (
            left.passable !== right.passable ||
            left.moveCost !== right.moveCost ||
            DIRECTIONS.some(
                (direction) => left.departures[direction] !== right.departures[direction],
            )
        ) {
            return false;
        }
    }

    return true;
}

function sameContributions(
    leftEffects: readonly ProjectedNavigationEffect[],
    rightEffects: readonly ProjectedNavigationEffect[],
    mode: PathMotionMode,
): boolean {
    if (leftEffects === rightEffects) {
        return true;
    }

    const contributes = (effect: ProjectedNavigationEffect) =>
        effect.definition[mode] !== null && effect.positions.length > 0;
    const left = leftEffects.filter(contributes);
    const right = rightEffects.filter(contributes);

    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index++) {
        const leftEffect = left[index]!;
        const rightEffect = right[index]!;
        const leftRestriction = leftEffect.definition[mode]!;
        const rightRestriction = rightEffect.definition[mode]!;

        if (
            leftRestriction.denyPassage !== rightRestriction.denyPassage ||
            (mode === "WALK" &&
                leftEffect.definition.WALK!.costFloor !== rightEffect.definition.WALK!.costFloor) ||
            DIRECTIONS.some(
                (direction) =>
                    leftRestriction.deniedDepartures.includes(direction) !==
                    rightRestriction.deniedDepartures.includes(direction),
            ) ||
            leftEffect.positions.length !== rightEffect.positions.length ||
            leftEffect.positions.some((position, positionIndex) => {
                const other = rightEffect.positions[positionIndex]!;

                return position[0] !== other[0] || position[1] !== other[1];
            })
        ) {
            return false;
        }
    }

    return true;
}

export function projectNavigationMaps(
    baseline: NavigationMaps,
    effects: readonly ProjectedNavigationEffect[],
    previous: NavigationMaps,
    previousEffects?: readonly ProjectedNavigationEffect[],
): NavigationProjection {
    const maps: Record<PathMotionMode, NavigationMap> = { WALK: previous.WALK, FLY: previous.FLY };
    const changedModes: PathMotionMode[] = [];

    for (const mode of ["WALK", "FLY"] as const) {
        if (previousEffects !== undefined && sameContributions(effects, previousEffects, mode)) {
            continue;
        }

        const baselineMap = baseline[mode];
        const previousMap = previous[mode];
        const cells = projectCells(baselineMap, effects);

        if (sameCells(cells, previousMap.cells)) {
            continue;
        }

        const revision = previousMap.revision + 1;

        if (!Number.isSafeInteger(revision)) {
            throw new RangeError("navigation revision overflow");
        }

        maps[mode] = Object.freeze({
            rows: baselineMap.rows,
            columns: baselineMap.columns,
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
