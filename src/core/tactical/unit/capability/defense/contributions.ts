import type {
    ComputedEffectContribution,
    EffectContributionOptions,
    SampledEffectContribution,
} from "../effects/contributions.js";
import { defenseContributions, resistanceContributions } from "./capability.js";

export function defense<S extends object>(
    sample: SampledEffectContribution<S>["sample"],
    options: EffectContributionOptions = {},
): SampledEffectContribution<S> {
    return {
        id: options.id ?? "defense",
        target: defenseContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function computedDefense<S extends object>(
    compute: ComputedEffectContribution<S>["compute"],
    options: EffectContributionOptions = {},
): ComputedEffectContribution<S> {
    return {
        id: options.id ?? "defense",
        target: defenseContributions,
        providers: (resources) => resources.defense,
        compute,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function resistance<S extends object>(
    sample: SampledEffectContribution<S>["sample"],
    options: EffectContributionOptions = {},
): SampledEffectContribution<S> {
    return {
        id: options.id ?? "resistance",
        target: resistanceContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function computedResistance<S extends object>(
    compute: ComputedEffectContribution<S>["compute"],
    options: EffectContributionOptions = {},
): ComputedEffectContribution<S> {
    return {
        id: options.id ?? "resistance",
        target: resistanceContributions,
        providers: (resources) => resources.defense,
        compute,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
