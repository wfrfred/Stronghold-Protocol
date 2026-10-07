import { Tile, World, type WorldOffset, type WorldPosition } from "../../../geometry/coordinate.js";
import { NavigationMap } from "../../../battlefield/navigation/map.js";
import {
    integrateSteeringDirection,
    type SteeringParameters,
    type SteeringResult,
    type SteeringState,
} from "./steering.js";

export type MotionOverride =
    | {
          readonly type: "DISPLACEMENT";
          readonly displacement: WorldOffset;
      }
    | {
          readonly type: "DIRECTION";
          readonly direction: WorldOffset;
      };

export function getNavigationRecoveryTarget(
    map: NavigationMap,
    position: WorldPosition,
    locatorOffset: WorldOffset,
): WorldPosition | null {
    const [minimum, maximum] = NavigationMap.bounds(map);
    const minX = Math.max(minimum[0], minimum[0] - locatorOffset[0]);
    const maxX = Math.min(maximum[0], maximum[0] - locatorOffset[0]);
    const minY = Math.max(minimum[1], minimum[1] - locatorOffset[1]);
    const maxY = Math.min(maximum[1], maximum[1] - locatorOffset[1]);

    if (minX > maxX || minY > maxY) {
        return null;
    }

    return [
        Math.max(minX, Math.min(maxX, position[0])),
        Math.max(minY, Math.min(maxY, position[1])),
    ];
}

export function reflectNavigationMovement(
    position: WorldPosition,
    nextPosition: WorldPosition,
    map: NavigationMap,
): WorldPosition {
    const origin = World.toTile(position);

    if (!NavigationMap.contains(map, origin)) {
        return nextPosition;
    }

    const destination = World.toTile(nextPosition);

    if (
        (destination[0] === origin[0] && destination[1] === origin[1]) ||
        NavigationMap.get(map, destination)?.passable === true
    ) {
        return nextPosition;
    }

    const normal = World.difference(Tile.center(destination), position);
    const magnitude = Math.hypot(normal[0], normal[1]);
    const unitNormal = World.scale(normal, 1 / magnitude);
    const displacement = World.difference(nextPosition, position);
    const dot = displacement[0] * unitNormal[0] + displacement[1] * unitNormal[1];

    return World.translate(
        position,
        World.difference(displacement, World.scale(unitNormal, 2 * dot)),
    );
}

export function applyMotionOverride(
    state: Readonly<SteeringState>,
    position: WorldPosition,
    override: MotionOverride,
    moveSpeedPerTick: number,
    parameters: SteeringParameters,
): SteeringResult {
    if (override.type === "DISPLACEMENT") {
        return {
            position: World.translate(position, override.displacement),
            state: { lastVelocity: state.lastVelocity },
        };
    }

    return integrateSteeringDirection(
        state,
        position,
        override.direction,
        moveSpeedPerTick,
        parameters,
    );
}
