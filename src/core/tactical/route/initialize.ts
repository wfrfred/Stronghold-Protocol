import type { Rng } from "../../common/rng.js";
import { createWorldOffset, createWorldPosition, Tile } from "../geometry/coordinate.js";
import type { WorldOffset, WorldPosition } from "../geometry/coordinate.js";
import { createRouteDefinition } from "./definition.js";
import type { RouteDefinition } from "./definition.js";

export interface RouteSpawn {
    readonly position: WorldPosition;
    readonly locatorOffset: WorldOffset;
}

export function initializeRouteSpawn(definition: RouteDefinition, rng: Rng): RouteSpawn {
    const snapshot = createRouteDefinition(definition);
    const center = Tile.center(snapshot.startPosition);
    for (let axis = 0; axis < 2; axis++) {
        const range = snapshot.spawnRandomRange[axis]!;
        const offset = snapshot.spawnOffset[axis]!;
        const centerCoordinate = center[axis]!;
        if (!Number.isFinite(range * 2)
            || !Number.isFinite(offset - range)
            || !Number.isFinite(offset + range)
            || !Number.isFinite(centerCoordinate + offset - range)
            || !Number.isFinite(centerCoordinate + offset + range)) {
            throw new RangeError("route spawn bounds must be finite");
        }
    }

    const [rangeX, rangeY] = snapshot.spawnRandomRange;
    const dx = snapshot.spawnOffset[0] + (-rangeX + rng.next() * (2 * rangeX));
    const dy = snapshot.spawnOffset[1] + (-rangeY + rng.next() * (2 * rangeY));

    return Object.freeze({
        position: createWorldPosition(center[0] + dx, center[1] + dy),
        locatorOffset: createWorldOffset(-dx, -dy),
    });
}
