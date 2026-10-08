import type * as contributions from "./effects/contributions.js";
import { updateBlockingCapacityContributions } from "./blocking.js";

export function blockingCapacity<S extends object>(
    sample: contributions.Stored<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Stored<S> {
    return {
        id: options.id ?? "blockingCapacity",
        target: updateBlockingCapacityContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
