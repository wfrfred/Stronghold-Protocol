import { createWorldOffset, World } from "../../geometry/coordinate.js";
import type { WorldOffset, WorldPosition } from "../../geometry/coordinate.js";

export interface SteeringState {
    lastVelocity: WorldOffset;
}

export interface SteeringParameters {
    readonly steeringFactor: number;
    readonly maxSteeringForce: number;
}

export interface SteeringResult {
    readonly position: WorldPosition;
    readonly state: SteeringState;
}

export function createSteeringState(): SteeringState {
    return { lastVelocity: createWorldOffset(0, 0) };
}

export function createSteeringParameters(parameters: SteeringParameters): SteeringParameters {
    const { steeringFactor, maxSteeringForce } = parameters;
    if (!Number.isFinite(steeringFactor) || steeringFactor < 0) {
        throw new RangeError("steeringFactor must be finite and non-negative");
    }
    if (!Number.isFinite(maxSteeringForce) || maxSteeringForce < 0) {
        throw new RangeError("maxSteeringForce must be finite and non-negative");
    }
    return Object.freeze({ steeringFactor, maxSteeringForce });
}

export function integrateSteering(
    state: Readonly<SteeringState>,
    position: WorldPosition,
    target: WorldPosition,
    moveSpeedPerTick: number,
    parameters: SteeringParameters,
): SteeringResult {
    if (moveSpeedPerTick <= 0) {
        return {
            position,
            state: { lastVelocity: state.lastVelocity },
        };
    }
    const distanceSquared = World.distanceSquared(target, position);
    const direction = distanceSquared === 0
        ? createWorldOffset(0, 0)
        : World.scale(World.difference(target, position), 1 / Math.sqrt(distanceSquared));
    const desired = World.scale(direction, moveSpeedPerTick);
    const force = World.clampMagnitude(
        World.scale(World.difference(desired, state.lastVelocity), parameters.steeringFactor),
        parameters.maxSteeringForce,
    );
    const velocity = World.clampMagnitude(
        World.add(state.lastVelocity, force),
        moveSpeedPerTick,
    );
    const nextPosition = World.translate(position, velocity);
    return {
        position: nextPosition,
        state: { lastVelocity: velocity },
    };
}
