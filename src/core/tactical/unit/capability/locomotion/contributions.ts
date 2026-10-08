import type * as contributions from "../effects/contributions.js";
import { updateMoveSpeedContributions } from "./capability.js";

export function moveSpeed<S extends object>(
    sample: contributions.Stored<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Stored<S> {
    return {
        id: options.id ?? "moveSpeed",
        target: updateMoveSpeedContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function computedMoveSpeed<S extends object>(
    compute: contributions.Computed<S>["compute"],
    options: contributions.Options<S> = {},
): contributions.Computed<S> {
    return {
        id: options.id ?? "moveSpeed",
        target: updateMoveSpeedContributions,
        compute,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
