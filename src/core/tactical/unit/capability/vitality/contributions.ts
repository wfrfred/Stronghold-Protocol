import type {
    EffectContributionOptions,
    SampledEffectContribution,
} from "../effects/contributions.js";
import { vitalityMaxHpContributions } from "./capability.js";

export function maxHp<S extends object>(
    sample: SampledEffectContribution<S>["sample"],
    options: EffectContributionOptions = {},
): SampledEffectContribution<S> {
    return {
        id: options.id ?? "maxHp",
        target: vitalityMaxHpContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
