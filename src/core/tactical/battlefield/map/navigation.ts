import { Tile } from "../../geometry/coordinate.js";
import { Direction } from "../../geometry/direction.js";
import { Map, type Cell } from "../navigation/map.js";
import type { MotionMode } from "../navigation/state.js";
import { BattlefieldMap } from "./map.js";
import type { PassableMask } from "./tile.js";

const HOLE_COST = 1_000_000;

function includesMode(mask: PassableMask, mode: MotionMode): boolean {
    return mask === "ALL" || mask === (mode === "WALK" ? "WALK_ONLY" : "FLY_ONLY");
}

export function create(map: BattlefieldMap, mode: MotionMode): Map {
    const cells: Cell[] = map.tiles.map((tile) => ({
        passable: includesMode(tile.passableMask, mode),
        cost: mode === "WALK" && tile.terrain === "HOLE" ? HOLE_COST : 1,
        departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true },
    }));

    for (const edge of map.blockEdges) {
        if (!includesMode(edge.blockMask, mode)) {
            continue;
        }

        const adjacent = Tile.translate(edge.position, Direction.vector(edge.direction));

        for (const [position, direction] of [
            [edge.position, edge.direction],
            [adjacent, Direction.opposite(edge.direction)],
        ] as const) {
            if (!BattlefieldMap.contains(map, position)) {
                continue;
            }

            const index = position[0] * map.columns + position[1];
            const cell = cells[index]!;

            cells[index] = {
                ...cell,
                departures: { ...cell.departures, [direction]: false },
            };
        }
    }

    return new Map(map.rows, map.columns, cells);
}
