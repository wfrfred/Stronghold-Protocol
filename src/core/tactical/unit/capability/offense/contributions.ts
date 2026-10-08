import type {
    ComputedEffectContribution,
    EffectContributionOptions,
    SampledEffectContribution,
} from "../effects/contributions.js";
import { offenseAttackContributions } from "./capability.js";

export function attack<S extends object>(
    sample: SampledEffectContribution<S>["sample"],
    options: EffectContributionOptions = {},
): SampledEffectContribution<S> {
    return {
        id: options.id ?? "attack",
        target: offenseAttackContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function computedAttack<S extends object>(
    compute: ComputedEffectContribution<S>["compute"],
    options: EffectContributionOptions = {},
): ComputedEffectContribution<S> {
    return {
        id: options.id ?? "attack",
        target: offenseAttackContributions,
        providers: (resources) => resources.offense,
        compute,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
