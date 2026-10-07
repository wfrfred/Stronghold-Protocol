import type { UnitDefinition } from "../unit.js";

export interface OffenseDefinition {
    readonly attack: number;
}

export interface OffensiveUnitDefinition extends UnitDefinition {
    readonly offense: OffenseDefinition;
}

export function hasOffenseDefinition(
    definition: UnitDefinition,
): definition is OffensiveUnitDefinition {
    return "offense" in definition;
}

export function createOffenseDefinition(definition: OffenseDefinition): OffenseDefinition {
    if (!Number.isFinite(definition.attack) || definition.attack < 0) {
        throw new RangeError("attack must be finite and nonnegative");
    }

    return Object.freeze({ attack: definition.attack });
}
