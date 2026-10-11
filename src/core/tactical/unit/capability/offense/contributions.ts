import type * as contributions from "../effects/contributions.js";
import { setAttackContribution, removeAttackContribution } from "./capability.js";

export function attack<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "attack",
        set: setAttackContribution,
        remove: removeAttackContribution,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function liveAttack<S extends object>(
    evaluate: contributions.Live<S>["evaluate"],
    options: contributions.Options<S> = {},
): contributions.Live<S> {
    return {
        kind: "LIVE",
        id: options.id ?? "attack",
        set: setAttackContribution,
        remove: removeAttackContribution,
        evaluate,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
