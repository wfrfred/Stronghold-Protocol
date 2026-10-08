import type * as contributions from "../effects/contributions.js";
import { updateDefenseContributions, updateResistanceContributions } from "./capability.js";

export function defense<S extends object>(
    sample: contributions.Stored<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Stored<S> {
    return {
        id: options.id ?? "defense",
        target: updateDefenseContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function computedDefense<S extends object>(
    compute: contributions.Computed<S>["compute"],
    options: contributions.Options<S> = {},
): contributions.Computed<S> {
    return {
        id: options.id ?? "defense",
        target: updateDefenseContributions,
        compute,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function resistance<S extends object>(
    sample: contributions.Stored<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Stored<S> {
    return {
        id: options.id ?? "resistance",
        target: updateResistanceContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function computedResistance<S extends object>(
    compute: contributions.Computed<S>["compute"],
    options: contributions.Options<S> = {},
): contributions.Computed<S> {
    return {
        id: options.id ?? "resistance",
        target: updateResistanceContributions,
        compute,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
