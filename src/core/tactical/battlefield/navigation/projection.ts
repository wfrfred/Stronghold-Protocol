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
import type { NavigationModifierDefinition } from "./modifier.js";

export interface ProjectedNavigationModifier {
    readonly definition: NavigationModifierDefinition;
    readonly positions: readonly TilePosition[];
}

const HOLE_MOVE_COST = 1_000_000;

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
        moveCost: pathMotionMode === "WALK" && tile.terrain === "HOLE" ? HOLE_MOVE_COST : 1,
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
    navigationModifiers: readonly ProjectedNavigationModifier[],
): readonly NavigationCell[] {
    const cells = baseline.cells.slice();

    for (const navigationModifier of navigationModifiers) {
        const restriction = navigationModifier.definition[baseline.pathMotionMode];

        if (restriction === null) {
            continue;
        }

        for (const position of navigationModifier.positions) {
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
                    ? Math.max(cell.moveCost, navigationModifier.definition.WALK!.costFloor)
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
    leftNavigationModifiers: readonly ProjectedNavigationModifier[],
    rightNavigationModifiers: readonly ProjectedNavigationModifier[],
    mode: PathMotionMode,
): boolean {
    if (leftNavigationModifiers === rightNavigationModifiers) {
        return true;
    }

    const contributes = (navigationModifier: ProjectedNavigationModifier) =>
        navigationModifier.definition[mode] !== null && navigationModifier.positions.length > 0;
    const left = leftNavigationModifiers.filter(contributes);
    const right = rightNavigationModifiers.filter(contributes);

    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index++) {
        const leftNavigationModifier = left[index]!;
        const rightNavigationModifier = right[index]!;
        const leftRestriction = leftNavigationModifier.definition[mode]!;
        const rightRestriction = rightNavigationModifier.definition[mode]!;

        if (
            leftRestriction.denyPassage !== rightRestriction.denyPassage ||
            (mode === "WALK" &&
                leftNavigationModifier.definition.WALK!.costFloor !==
                    rightNavigationModifier.definition.WALK!.costFloor) ||
            DIRECTIONS.some(
                (direction) =>
                    leftRestriction.deniedDepartures.includes(direction) !==
                    rightRestriction.deniedDepartures.includes(direction),
            ) ||
            leftNavigationModifier.positions.length !== rightNavigationModifier.positions.length ||
            leftNavigationModifier.positions.some((position, positionIndex) => {
                const other = rightNavigationModifier.positions[positionIndex]!;

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
    navigationModifiers: readonly ProjectedNavigationModifier[],
    previous: NavigationMaps,
    previousNavigationModifiers?: readonly ProjectedNavigationModifier[],
): NavigationProjection {
    const maps: Record<PathMotionMode, NavigationMap> = { WALK: previous.WALK, FLY: previous.FLY };
    const changedModes: PathMotionMode[] = [];

    for (const mode of ["WALK", "FLY"] as const) {
        if (
            previousNavigationModifiers !== undefined &&
            sameContributions(navigationModifiers, previousNavigationModifiers, mode)
        ) {
            continue;
        }

        const baselineMap = baseline[mode];
        const previousMap = previous[mode];
        const cells = projectCells(baselineMap, navigationModifiers);

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
