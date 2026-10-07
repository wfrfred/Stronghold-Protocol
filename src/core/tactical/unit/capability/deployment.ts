import type { BuildableType, HeightType } from "../../battlefield/map/tile.js";
import type { UnitDefinition } from "../unit.js";

export interface DeploymentProfile {
    readonly buildableType: Exclude<BuildableType, "NONE">;
    readonly advancedBuildableMask: number;
}

export interface DeployableUnitDefinition extends UnitDefinition {
    readonly deployment: DeploymentProfile;
}

export interface TileBindingDefinition {
    readonly heightType: HeightType | null;
    readonly buildableType: BuildableType;
    readonly advancedBuildableMask: number | null;
}

export interface TileBoundUnitDefinition extends UnitDefinition {
    readonly tileBinding: TileBindingDefinition;
}

export function hasDeploymentDefinition(
    definition: UnitDefinition,
): definition is DeployableUnitDefinition {
    return "deployment" in definition;
}

export function hasTileBindingDefinition(
    definition: UnitDefinition,
): definition is TileBoundUnitDefinition {
    return "tileBinding" in definition;
}

function requireAdvancedBuildableMask(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new RangeError("advanced buildable mask must be a uint32");
    }

    return value;
}

export function createDeploymentProfile(
    profile: Omit<DeploymentProfile, "advancedBuildableMask"> & {
        readonly advancedBuildableMask?: number;
    },
): DeploymentProfile {
    const buildableType: unknown = profile.buildableType;

    if (buildableType !== "MELEE" && buildableType !== "RANGED" && buildableType !== "ALL") {
        throw new TypeError("invalid deployment buildable type");
    }

    return Object.freeze({
        buildableType,
        advancedBuildableMask: requireAdvancedBuildableMask(profile.advancedBuildableMask ?? 1),
    });
}

export function createTileBindingDefinition(
    definition: Omit<TileBindingDefinition, "advancedBuildableMask"> & {
        readonly advancedBuildableMask?: number | null;
    },
): TileBindingDefinition {
    const heightType: unknown = definition.heightType;
    const buildableType: unknown = definition.buildableType;

    if (heightType !== null && heightType !== "LOWLAND" && heightType !== "HIGHLAND") {
        throw new TypeError("invalid tile binding height type");
    }
    if (
        buildableType !== "NONE" &&
        buildableType !== "MELEE" &&
        buildableType !== "RANGED" &&
        buildableType !== "ALL"
    ) {
        throw new TypeError("invalid tile binding buildable type");
    }

    return Object.freeze({
        heightType,
        buildableType,
        advancedBuildableMask:
            definition.advancedBuildableMask === undefined ||
            definition.advancedBuildableMask === null
                ? null
                : requireAdvancedBuildableMask(definition.advancedBuildableMask),
    });
}
