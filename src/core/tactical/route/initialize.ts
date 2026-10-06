import type { Rng } from "../../common/rng.js";
import { createWorldOffset, Tile, World } from "../geometry/coordinate.js";
import type { WorldOffset, WorldPosition } from "../geometry/coordinate.js";
import type { RouteDefinition } from "./definition.js";

export interface RouteSpawn {
    readonly position: WorldPosition;
    readonly locatorOffset: WorldOffset;
}

export function initializeRouteSpawn(definition: RouteDefinition, rng: Rng): RouteSpawn {
    const center = Tile.center(definition.startPosition);
    for (let axis = 0; axis < 2; axis++) {
        const range = definition.spawnRandomRange[axis]!;
        const offset = definition.spawnOffset[axis]!;
        const centerCoordinate = center[axis]!;
        if (!Number.isFinite(range * 2)
            || !Number.isFinite(offset - range)
            || !Number.isFinite(offset + range)
            || !Number.isFinite(centerCoordinate + offset - range)
            || !Number.isFinite(centerCoordinate + offset + range)) {
            throw new RangeError("route spawn bounds must be finite");
        }
    }

    const [rangeX, rangeY] = definition.spawnRandomRange;
    const dx = definition.spawnOffset[0] + (-rangeX + rng.next() * (2 * rangeX));
    const dy = definition.spawnOffset[1] + (-rangeY + rng.next() * (2 * rangeY));
    const offset = createWorldOffset(dx, dy);

    return Object.freeze({
        position: World.translate(center, offset),
        locatorOffset: World.negate(offset),
    });
}
