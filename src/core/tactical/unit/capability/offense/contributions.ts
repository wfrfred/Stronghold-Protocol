import type * as contributions from "../effects/contributions.js";
import { updateAttackContributions } from "./capability.js";

export function attack<S extends object>(
    sample: contributions.Stored<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Stored<S> {
    return {
        id: options.id ?? "attack",
        target: updateAttackContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function computedAttack<S extends object>(
    compute: contributions.Computed<S>["compute"],
    options: contributions.Options<S> = {},
): contributions.Computed<S> {
    return {
        id: options.id ?? "attack",
        target: updateAttackContributions,
        compute,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
