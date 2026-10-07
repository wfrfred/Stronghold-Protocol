import { assertNonnegativeNumber } from "../../../../common/assert.js";
import {
    createWorldOffset,
    World,
    type WorldOffset,
    type WorldPosition,
} from "../../../geometry/coordinate.js";

export interface SteeringState {
    readonly lastVelocity: WorldOffset;
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

    assertNonnegativeNumber(steeringFactor, "steeringFactor");
    assertNonnegativeNumber(maxSteeringForce, "maxSteeringForce");

    return Object.freeze({ steeringFactor, maxSteeringForce });
}

export function integrateSteering(
    state: Readonly<SteeringState>,
    position: WorldPosition,
    target: WorldPosition,
    moveSpeedPerTick: number,
    parameters: SteeringParameters,
): SteeringResult {
    return integrateSteeringDirection(
        state,
        position,
        World.difference(target, position),
        moveSpeedPerTick,
        parameters,
    );
}

export function integrateSteeringDirection(
    state: Readonly<SteeringState>,
    position: WorldPosition,
    direction: WorldOffset,
    moveSpeedPerTick: number,
    parameters: SteeringParameters,
): SteeringResult {
    if (moveSpeedPerTick <= 0) {
        return {
            position,
            state,
        };
    }

    const magnitude = Math.hypot(direction[0], direction[1]);
    const heading =
        magnitude === 0 ? createWorldOffset(0, 0) : World.scale(direction, 1 / magnitude);
    const desired = World.scale(heading, moveSpeedPerTick);
    const force = World.clampMagnitude(
        World.scale(World.difference(desired, state.lastVelocity), parameters.steeringFactor),
        parameters.maxSteeringForce,
    );
    const velocity = World.clampMagnitude(World.add(state.lastVelocity, force), moveSpeedPerTick);
    const nextPosition = World.translate(position, velocity);

    return {
        position: nextPosition,
        state: { lastVelocity: velocity },
    };
}
