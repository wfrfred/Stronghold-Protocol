import type * as contributions from "../effects/contributions.js";
import { updateMaxHpContributions } from "./capability.js";

export function maxHp<S extends object>(
    sample: contributions.Stored<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Stored<S> {
    return {
        id: options.id ?? "maxHp",
        target: updateMaxHpContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
