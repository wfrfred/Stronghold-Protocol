import type * as contributions from "../effects/contributions.js";
import { updateMoveSpeedContributions } from "./capability.js";

export function moveSpeed<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "moveSpeed",
        target: updateMoveSpeedContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function liveMoveSpeed<S extends object>(
    evaluate: contributions.Live<S>["evaluate"],
    options: contributions.Options<S> = {},
): contributions.Live<S> {
    return {
        kind: "LIVE",
        id: options.id ?? "moveSpeed",
        target: updateMoveSpeedContributions,
        evaluate,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
