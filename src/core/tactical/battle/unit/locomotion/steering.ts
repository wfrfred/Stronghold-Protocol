import { createWorldOffset } from "../../../geometry/coordinate.js";
import type { WorldOffset } from "../../../geometry/coordinate.js";

export interface SteeringState {
    lastVelocity: WorldOffset;
}

export interface SteeringParameters {
    readonly steeringFactor: number;
    readonly maxSteeringForce: number;
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
