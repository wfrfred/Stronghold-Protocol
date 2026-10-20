import { Tile, World, type WorldPosition } from "../../../geometry/coordinate.js";
import type { Map } from "../../../battlefield/navigation/map.js";

export function reflect(
    position: WorldPosition,
    nextPosition: WorldPosition,
    map: Map,
): WorldPosition {
    const origin = World.toTile(position);

    if (!map.contains(origin)) {
        return nextPosition;
    }

    const destination = World.toTile(nextPosition);

    if (
        (destination[0] === origin[0] && destination[1] === origin[1]) ||
        map.get(destination)?.passable === true
    ) {
        return nextPosition;
    }

    const normal = World.difference(Tile.center(destination), position);
    const magnitude = Math.hypot(normal[0], normal[1]);
    const unitNormal = World.scale(normal, 1 / magnitude);
    const delta = World.difference(nextPosition, position);
    const dot = delta[0] * unitNormal[0] + delta[1] * unitNormal[1];

    return World.translate(position, World.difference(delta, World.scale(unitNormal, 2 * dot)));
}
