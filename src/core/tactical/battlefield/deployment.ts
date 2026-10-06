import type { TilePosition } from "../geometry/coordinate.js";
import { hasTileBindingDefinition, type DeploymentProfile } from "../unit/capability/deployment.js";
import { hasOccupancy, type OccupancySlot } from "../unit/capability/occupancy.js";
import { isSpatiallyPresent } from "../unit/capability/presence.js";
import type { Unit, UnitId } from "../unit/unit.js";
import { BattlefieldMap } from "./map.js";
import type { BuildableType } from "./tile.js";

export interface DeploymentView {
    readonly map: BattlefieldMap;
    getUnit(id: UnitId): Unit | undefined;
    occupancyAt(position: TilePosition, slot: OccupancySlot): readonly UnitId[];
}

export interface DeploymentRequest {
    readonly profile: DeploymentProfile;
    readonly tile: TilePosition;
    readonly playerSide: "SIDE_A" | "SIDE_B";
    readonly relocatingUnitId?: UnitId;
    readonly slot?: OccupancySlot;
}

export type DeploymentDecision =
    | { readonly type: "ALLOWED"; readonly supportUnitId: UnitId | null }
    | {
          readonly type: "DENIED";
          readonly reason:
              "OUTSIDE_MAP" | "PLAYER_SIDE" | "OCCUPIED" | "BUILDABLE_TYPE" | "TERRAIN";
      };

const BUILDABLE_MASK: Readonly<Record<BuildableType, number>> = {
    NONE: 0,
    MELEE: 1,
    RANGED: 2,
    ALL: 3,
};

export function evaluateDeployment(
    view: DeploymentView,
    request: DeploymentRequest,
): DeploymentDecision {
    const tile = BattlefieldMap.get(view.map, request.tile);

    if (tile === undefined) {
        return { type: "DENIED", reason: "OUTSIDE_MAP" };
    }
    if (tile.playerSideMask !== "ALL" && tile.playerSideMask !== request.playerSide) {
        return { type: "DENIED", reason: "PLAYER_SIDE" };
    }

    const slot = request.slot ?? "DEPLOYMENT";
    const occupied = (claimSlot: OccupancySlot) =>
        view.occupancyAt(request.tile, claimSlot).filter((id) => id !== request.relocatingUnitId);

    if (occupied(slot).length > 0) {
        return { type: "DENIED", reason: "OCCUPIED" };
    }
    if (slot === "SUPPORT" && occupied("DEPLOYMENT").length > 0) {
        return { type: "DENIED", reason: "OCCUPIED" };
    }

    let buildableType = tile.buildableType;
    let advancedBuildableMask = tile.advancedBuildableMask ?? 0;
    let supportUnitId: UnitId | null = null;

    if (slot === "DEPLOYMENT") {
        const providers = occupied("SUPPORT");

        if (providers.length > 1) {
            return { type: "DENIED", reason: "OCCUPIED" };
        }
        if (providers.length === 1) {
            const provider = view.getUnit(providers[0]!);

            if (
                provider === undefined ||
                !isSpatiallyPresent(provider) ||
                !hasTileBindingDefinition(provider.definition) ||
                !hasOccupancy(provider) ||
                !provider.occupancy.claims.some(
                    (claim) =>
                        claim.slot === "SUPPORT" &&
                        claim.type === "PRESENT" &&
                        claim.position[0] === request.tile[0] &&
                        claim.position[1] === request.tile[1],
                )
            ) {
                return { type: "DENIED", reason: "OCCUPIED" };
            }

            buildableType = provider.definition.tileBinding.buildableType;
            advancedBuildableMask =
                provider.definition.tileBinding.advancedBuildableMask ?? advancedBuildableMask;
            supportUnitId = provider.id;
        }
    }

    if ((BUILDABLE_MASK[buildableType] & BUILDABLE_MASK[request.profile.buildableType]) === 0) {
        return { type: "DENIED", reason: "BUILDABLE_TYPE" };
    }
    if (
        (advancedBuildableMask & request.profile.advancedBuildableMask) >>> 0 !==
        advancedBuildableMask
    ) {
        return { type: "DENIED", reason: "TERRAIN" };
    }

    return { type: "ALLOWED", supportUnitId };
}
