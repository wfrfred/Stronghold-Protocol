import type * as contributions from "../../../contribution/definition.js";
import { updateAttackSpeedContributions, updateBaseAttackTimeContributions } from "./capability.js";

export function attackSpeed<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "attackSpeed",
        target: updateAttackSpeedContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function liveAttackSpeed<S extends object>(
    evaluate: contributions.Live<S>["evaluate"],
    options: contributions.Options<S> = {},
): contributions.Live<S> {
    return {
        kind: "LIVE",
        id: options.id ?? "attackSpeed",
        target: updateAttackSpeedContributions,
        evaluate,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function baseAttackTime<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "baseAttackTime",
        target: updateBaseAttackTimeContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function liveBaseAttackTime<S extends object>(
    evaluate: contributions.Live<S>["evaluate"],
    options: contributions.Options<S> = {},
): contributions.Live<S> {
    return {
        kind: "LIVE",
        id: options.id ?? "baseAttackTime",
        target: updateBaseAttackTimeContributions,
        evaluate,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
