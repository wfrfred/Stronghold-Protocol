import { createWorldOffset, World } from "../../../geometry/coordinate.js";
import type { WorldPosition } from "../../../geometry/coordinate.js";
import type { SteeringParameters, SteeringState } from "./steering.js";

export interface SteeringResult {
    readonly position: WorldPosition;
    readonly state: SteeringState;
}

export function integrateSteering(
    state: Readonly<SteeringState>,
    position: WorldPosition,
    target: WorldPosition,
    moveSpeed: number,
    deltaTimeSeconds: number,
    parameters: SteeringParameters,
): SteeringResult {
    if (moveSpeed <= 0) {
        return {
            position,
            state: { lastVelocity: state.lastVelocity },
        };
    }
    const distanceSquared = World.distanceSquared(target, position);
    const direction = distanceSquared === 0
        ? createWorldOffset(0, 0)
        : World.scale(World.difference(target, position), 1 / Math.sqrt(distanceSquared));
    const desired = World.scale(direction, moveSpeed);
    const force = World.clampMagnitude(
        World.scale(World.difference(desired, state.lastVelocity), parameters.steeringFactor),
        parameters.maxSteeringForce,
    );
    const velocity = World.clampMagnitude(
        World.add(state.lastVelocity, World.scale(force, deltaTimeSeconds)),
        moveSpeed,
    );
    const nextPosition = World.translate(position, World.scale(velocity, deltaTimeSeconds));
    return {
        position: nextPosition,
        state: { lastVelocity: velocity },
    };
}
