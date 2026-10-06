import type { UnitDefinition } from "../unit.js";

export interface DefenseDefinition {
    readonly defense: number;
    readonly resistance: number;
}

export interface DefendedUnitDefinition extends UnitDefinition {
    readonly defense: DefenseDefinition;
}

export function hasDefenseDefinition(
    definition: UnitDefinition,
): definition is DefendedUnitDefinition {
    return "defense" in definition;
}

export function createDefenseDefinition(definition: DefenseDefinition): DefenseDefinition {
    for (const [name, value] of [
        ["defense", definition.defense],
        ["resistance", definition.resistance],
    ] as const) {
        if (!Number.isFinite(value) || value < 0) {
            throw new RangeError(`${name} must be finite and nonnegative`);
        }
    }

    return Object.freeze({ defense: definition.defense, resistance: definition.resistance });
}
