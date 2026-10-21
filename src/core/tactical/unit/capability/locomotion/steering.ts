import { assertNonnegativeNumber } from "../../../../common/assert.js";
import { createWorldPosition, World, type WorldPosition } from "../../../geometry/coordinate.js";

export interface SteeringParameters {
    readonly steeringFactor: number;
    readonly maxSteeringForce: number;
}

export function createSteeringParameters(parameters: SteeringParameters): SteeringParameters {
    const { steeringFactor, maxSteeringForce } = parameters;

    assertNonnegativeNumber(steeringFactor, "steeringFactor");
    assertNonnegativeNumber(maxSteeringForce, "maxSteeringForce");

    return Object.freeze({ steeringFactor, maxSteeringForce });
}

export function integrate(
    velocity: WorldPosition,
    direction: WorldPosition,
    speed: number,
    localForce: WorldPosition,
    parameters: SteeringParameters,
): WorldPosition {
    const magnitude = Math.hypot(direction[0], direction[1]);
    const heading =
        magnitude > 1e-5 ? World.scale(direction, 1 / magnitude) : createWorldPosition(0, 0);
    const desired = World.scale(heading, speed);
    const force = World.clampLength(
        World.add(localForce, World.scale(World.sub(desired, velocity), parameters.steeringFactor)),
        parameters.maxSteeringForce,
    );

    return World.clampLength(World.add(velocity, force), speed);
}
