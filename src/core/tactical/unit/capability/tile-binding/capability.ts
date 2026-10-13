import type { BuildableType, HeightType } from "../../../battlefield/map/tile.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";

export interface Definition {
    readonly heightType: HeightType | null;
    readonly buildableType: BuildableType;
    readonly advancedBuildableMask: number | null;
}

export interface TileBinding {
    readonly definition: { readonly tileBinding: Definition };
}

export function hasTileBinding<U extends Unit>(unit: U): unit is U & TileBinding {
    return hasDefinition(unit.definition);
}

export function hasDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & TileBinding["definition"] {
    return "tileBinding" in definition;
}

export function createDefinition(
    definition: Omit<Definition, "advancedBuildableMask"> & {
        readonly advancedBuildableMask?: number | null;
    },
): Definition {
    const advancedBuildableMask = definition.advancedBuildableMask ?? null;

    if (
        advancedBuildableMask !== null &&
        (!Number.isInteger(advancedBuildableMask) ||
            advancedBuildableMask < 0 ||
            advancedBuildableMask > 0xffff_ffff)
    ) {
        throw new RangeError("advanced buildable mask must be a uint32");
    }

    return Object.freeze({
        heightType: definition.heightType,
        buildableType: definition.buildableType,
        advancedBuildableMask,
    });
}
