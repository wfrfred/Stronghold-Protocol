import type * as contributions from "../effects/contributions.js";
import { setMaxHpContribution, removeMaxHpContribution } from "./capability.js";

export function maxHp<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "maxHp",
        set: setMaxHpContribution,
        remove: removeMaxHpContribution,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
