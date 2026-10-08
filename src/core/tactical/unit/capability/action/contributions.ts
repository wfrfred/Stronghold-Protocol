import type * as contributions from "../effects/contributions.js";
import { updateAttackSpeedContributions, updateBaseAttackTimeContributions } from "./capability.js";

export function attackSpeed<S extends object>(
    sample: contributions.Stored<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Stored<S> {
    return {
        id: options.id ?? "attackSpeed",
        target: updateAttackSpeedContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function computedAttackSpeed<S extends object>(
    compute: contributions.Computed<S>["compute"],
    options: contributions.Options<S> = {},
): contributions.Computed<S> {
    return {
        id: options.id ?? "attackSpeed",
        target: updateAttackSpeedContributions,
        compute,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function baseAttackTime<S extends object>(
    sample: contributions.Stored<S>["sample"],
    options: contributions.Options<S> = {},
): contributions.Stored<S> {
    return {
        id: options.id ?? "baseAttackTime",
        target: updateBaseAttackTimeContributions,
        sample,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}

export function computedBaseAttackTime<S extends object>(
    compute: contributions.Computed<S>["compute"],
    options: contributions.Options<S> = {},
): contributions.Computed<S> {
    return {
        id: options.id ?? "baseAttackTime",
        target: updateBaseAttackTimeContributions,
        compute,
        ...(options.group === undefined ? {} : { group: options.group }),
    };
}
