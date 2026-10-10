import type * as contributions from "../../../contribution/definition.js";
import { updateBlockingCapacityContributions } from "./capability.js";

export function capacity<S extends object>(
    sample: contributions.Sampled<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Sampled<S> {
    return {
        kind: "SAMPLED",
        id: options.id ?? "blockingCapacity",
        target: updateBlockingCapacityContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
