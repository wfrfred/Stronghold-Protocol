import type * as contributions from "../effects/contributions.js";
import { setCapacityContribution, removeCapacityContribution } from "./capability.js";

export function capacity<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "blockingCapacity",
        set: setCapacityContribution,
        remove: removeCapacityContribution,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
