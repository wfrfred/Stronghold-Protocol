import type { Map } from "../../../battlefield/navigation/map.js";
import type { MotionMode } from "../../../battlefield/navigation/state.js";
import {
    createWorldOffset,
    Tile,
    World,
    type TileOffset,
    type WorldOffset,
    type WorldPosition,
} from "../../../geometry/coordinate.js";
import { TICKS_PER_SECOND } from "../../../tick.js";

const NEIGHBORS: readonly TileOffset[] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
];

function terrainForce(
    map: Map,
    mode: MotionMode,
    position: WorldPosition,
    halfBodyWidth: number,
): WorldOffset {
    const tile = World.toTile(position);
    const current = map.get(tile);

    if (current === undefined) {
        return createWorldOffset(0, 0);
    }
    if (!current.passable) {
        let nearest = Number.POSITIVE_INFINITY;
        let force = createWorldOffset(0, 0);

        for (const offset of NEIGHBORS) {
            const neighbor = Tile.translate(tile, offset);

            if (map.get(neighbor)?.passable !== true) {
                continue;
            }

            const distance = World.distanceSquared(position, Tile.center(neighbor));

            if (distance < nearest) {
                nearest = distance;
                force = createWorldOffset(offset[1], offset[0]);
            }
        }

        return force;
    }

    const center = Tile.center(tile);
    let x = 0;
    let y = 0;

    for (const [row, col] of NEIGHBORS) {
        const neighbor = map.get(Tile.translate(tile, [row, col]));

        if (
            neighbor === undefined ||
            (neighbor.passable && (mode === "FLY" || neighbor.cost < 1000))
        ) {
            continue;
        }

        const horizontal =
            Math.abs(col) *
            (Math.max(0, (position[0] + col * halfBodyWidth - center[0]) * col) - 0.25);
        const vertical = Math.abs(row) * (Math.max(0, (position[1] - center[1]) * row) - 0.25);

        if (horizontal > 0 && vertical > 0) {
            const average = (horizontal + vertical) / 2;

            x -= 2 * average * col;
            y -= 2 * average * row;
        } else if (Math.abs(row) + Math.abs(col) === 1 && (horizontal > 0 || vertical > 0)) {
            x -= 2 * horizontal * col;
            y -= 2 * vertical * row;
        }
    }

    const magnitude = Math.hypot(x, y);

    return magnitude > 0.00001
        ? createWorldOffset(x / magnitude, y / magnitude)
        : createWorldOffset(0, 0);
}

export function calculate(
    map: Map,
    mode: MotionMode,
    position: WorldPosition,
    halfBodyWidth: number,
    direction: WorldOffset,
    velocity: WorldOffset,
    speed: number,
): WorldOffset {
    if (speed <= 0) {
        return createWorldOffset(0, 0);
    }

    const magnitude = Math.hypot(direction[0], direction[1]);
    const heading =
        magnitude > 0.00001 ? World.scale(direction, 1 / magnitude) : createWorldOffset(0, 0);
    const force = terrainForce(map, mode, position, halfBodyWidth);
    const projection = force[0] * heading[0] + force[1] * heading[1];
    const scale = Math.max(0.5, Math.hypot(velocity[0], velocity[1]) / speed);

    return createWorldOffset(
        ((force[0] - projection * heading[0]) * scale) / TICKS_PER_SECOND ** 2,
        ((force[1] - projection * heading[1]) * scale) / TICKS_PER_SECOND ** 2,
    );
}
