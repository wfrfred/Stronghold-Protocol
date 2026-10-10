import type * as contributions from "../effects/contributions.js";
import { updateDefenseContributions, updateResistanceContributions } from "./capability.js";

export function defense<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "defense",
        target: updateDefenseContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function liveDefense<S extends object>(
    evaluate: contributions.Live<S>["evaluate"],
    options: contributions.Options<S> = {},
): contributions.Live<S> {
    return {
        kind: "LIVE",
        id: options.id ?? "defense",
        target: updateDefenseContributions,
        evaluate,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function resistance<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "resistance",
        target: updateResistanceContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function liveResistance<S extends object>(
    evaluate: contributions.Live<S>["evaluate"],
    options: contributions.Options<S> = {},
): contributions.Live<S> {
    return {
        kind: "LIVE",
        id: options.id ?? "resistance",
        target: updateResistanceContributions,
        evaluate,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
