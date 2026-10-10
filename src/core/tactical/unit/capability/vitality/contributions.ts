import type * as contributions from "../../../contribution/definition.js";
import { updateMaxHpContributions } from "./capability.js";
import { preserveHpRatio } from "./max-hp.js";

export function maxHp<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "maxHp",
        target: updateMaxHpContributions,
        reconcile: preserveHpRatio,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
