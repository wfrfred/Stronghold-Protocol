import type * as contributions from "../effects/contributions.js";
import {
    setAttackSpeedContribution,
    removeAttackSpeedContribution,
    setBaseAttackTimeContribution,
    removeBaseAttackTimeContribution,
} from "./capability.js";

export function attackSpeed<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "attackSpeed",
        set: setAttackSpeedContribution,
        remove: removeAttackSpeedContribution,
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
        set: setAttackSpeedContribution,
        remove: removeAttackSpeedContribution,
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
        set: setBaseAttackTimeContribution,
        remove: removeBaseAttackTimeContribution,
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
        set: setBaseAttackTimeContribution,
        remove: removeBaseAttackTimeContribution,
        evaluate,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
