import { assertNonnegativeNumber } from "../../../../common/assert.js";
import { createWorldOffset, World, type WorldOffset } from "../../../geometry/coordinate.js";

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
    velocity: WorldOffset,
    direction: WorldOffset,
    speed: number,
    localForce: WorldOffset,
    parameters: SteeringParameters,
): WorldOffset {
    const magnitude = Math.hypot(direction[0], direction[1]);
    const heading =
        magnitude > 1e-5 ? World.scale(direction, 1 / magnitude) : createWorldOffset(0, 0);
    const desired = World.scale(heading, speed);
    const force = World.clampMagnitude(
        World.add(
            localForce,
            World.scale(World.difference(desired, velocity), parameters.steeringFactor),
        ),
        parameters.maxSteeringForce,
    );

    return World.clampMagnitude(World.add(velocity, force), speed);
}
