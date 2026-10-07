import { assertNonnegativeSafeInteger, assertPositiveSafeInteger } from "../../../common/assert.js";
import type { TilePosition, WorldPosition } from "../../geometry/coordinate.js";
import { DIRECTIONS, type Direction } from "../../geometry/direction.js";

export type PathMotionMode = "WALK" | "FLY";

export type NavigationRevision = number;

export interface NavigationCell {
    readonly passable: boolean;
    readonly moveCost: number;
    readonly departures: Readonly<Record<Direction, boolean>>;
}

export interface NavigationMap {
    readonly rows: number;
    readonly columns: number;
    readonly pathMotionMode: PathMotionMode;
    readonly revision: NavigationRevision;
    readonly cells: readonly NavigationCell[];
}

export type NavigationMaps = Readonly<Record<PathMotionMode, NavigationMap>>;

export const PathMotionMode = {
    is(value: unknown): value is PathMotionMode {
        return value === "WALK" || value === "FLY";
    },
};

export const NavigationMap = {
    bounds(map: NavigationMap): readonly [min: WorldPosition, max: WorldPosition] {
        const margin = Number.EPSILON * Math.max(map.rows, map.columns);

        return [
            [-0.5 + margin, -0.5 + margin],
            [map.columns - 0.5 - margin, map.rows - 0.5 - margin],
        ];
    },

    contains(map: NavigationMap, position: TilePosition): boolean {
        const [row, col] = position;

        return row >= 0 && row < map.rows && col >= 0 && col < map.columns;
    },

    get(map: NavigationMap, position: TilePosition): NavigationCell | undefined {
        if (!NavigationMap.contains(map, position)) {
            return undefined;
        }

        return map.cells[position[0] * map.columns + position[1]];
    },

    canDepart(map: NavigationMap, position: TilePosition, direction: Direction): boolean {
        const cell = NavigationMap.get(map, position);

        return cell !== undefined && cell.passable && cell.departures[direction];
    },
};

export function createNavigationMap(map: NavigationMap): NavigationMap {
    assertPositiveSafeInteger(map.rows, "navigation row count");
    assertPositiveSafeInteger(map.columns, "navigation column count");

    if (!Number.isSafeInteger(map.rows * map.columns) || map.rows * map.columns > 0xffff_ffff) {
        throw new RangeError("invalid navigation map dimensions");
    }
    if (!PathMotionMode.is(map.pathMotionMode)) {
        throw new TypeError("invalid path motion mode");
    }

    assertNonnegativeSafeInteger(map.revision, "navigation revision");

    const cellsAreArray: boolean = Array.isArray(map.cells);

    if (!cellsAreArray || map.cells.length !== map.rows * map.columns) {
        throw new RangeError("navigation cells must match map dimensions");
    }

    const cells: NavigationCell[] = [];

    for (let index = 0; index < map.cells.length; index++) {
        const cell = map.cells[index];
        const cellValue: unknown = cell;

        if (!Object.hasOwn(map.cells, index) || cell === undefined || cellValue === null) {
            throw new RangeError(`missing navigation cell at index ${index}`);
        }
        if (typeof cell.passable !== "boolean") {
            throw new TypeError(`invalid passability at index ${index}`);
        }

        assertPositiveSafeInteger(cell.moveCost, `navigation cost at index ${index}`);

        if (map.pathMotionMode === "FLY" && cell.moveCost !== 1) {
            throw new RangeError("FLY navigation costs must be 1");
        }

        const departureValues: unknown = cell.departures;

        if (
            departureValues === null ||
            typeof departureValues !== "object" ||
            DIRECTIONS.some((direction) => typeof cell.departures[direction] !== "boolean")
        ) {
            throw new TypeError(`invalid departure directions at index ${index}`);
        }

        cells.push(
            Object.freeze({
                passable: cell.passable,
                moveCost: cell.moveCost,
                departures: Object.freeze({
                    UP: cell.departures.UP,
                    RIGHT: cell.departures.RIGHT,
                    DOWN: cell.departures.DOWN,
                    LEFT: cell.departures.LEFT,
                }),
            }),
        );
    }

    return Object.freeze({
        rows: map.rows,
        columns: map.columns,
        pathMotionMode: map.pathMotionMode,
        revision: map.revision,
        cells: Object.freeze(cells),
    });
}
