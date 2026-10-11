import type * as contributions from "../effects/contributions.js";
import {
    setDefenseContribution,
    removeDefenseContribution,
    setResistanceContribution,
    removeResistanceContribution,
} from "./capability.js";

export function defense<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "defense",
        set: setDefenseContribution,
        remove: removeDefenseContribution,
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
        set: setDefenseContribution,
        remove: removeDefenseContribution,
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
        set: setResistanceContribution,
        remove: removeResistanceContribution,
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
        set: setResistanceContribution,
        remove: removeResistanceContribution,
        evaluate,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
