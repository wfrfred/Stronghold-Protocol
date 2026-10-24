import type { TilePosition } from "../../geometry/coordinate.js";
import type { Definition as DeployableDefinition } from "../../unit/capability/deployable/capability.js";
import { hasTileBinding } from "../../unit/capability/tile-binding/capability.js";
import type { Slot } from "../../unit/capability/occupancy/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import type { Id } from "../../unit/unit.js";
import { BattlefieldMap } from "../map/map.js";
import type { BuildableType } from "../map/tile.js";
import { at } from "../occupancy.js";
import type { State as BattlefieldState } from "../state.js";

export interface DeploymentRequest {
    readonly profile: DeployableDefinition;
    readonly tile: TilePosition;
    readonly playerSide: "SIDE_A" | "SIDE_B";
    readonly relocatingUnitId?: Id;
    readonly slot?: Slot;
}

export type DeploymentDecision =
    | { readonly type: "ALLOWED"; readonly supportUnitId: Id | null }
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
    field: BattlefieldState,
    request: DeploymentRequest,
): DeploymentDecision {
    const tile = BattlefieldMap.get(field.map, request.tile);

    if (tile === undefined) {
        return { type: "DENIED", reason: "OUTSIDE_MAP" };
    }
    if (tile.playerSideMask !== "ALL" && tile.playerSideMask !== request.playerSide) {
        return { type: "DENIED", reason: "PLAYER_SIDE" };
    }

    const slot = request.slot ?? "OCCUPANT";
    const occupancy = at(field, request.tile);

    const registered = (registrationSlot: Slot) => {
        const reference =
            registrationSlot === "OCCUPANT" ? occupancy?.occupant : occupancy?.support;

        return reference?.id === request.relocatingUnitId ? null : (reference ?? null);
    };

    if (registered(slot) !== null) {
        return { type: "DENIED", reason: "OCCUPIED" };
    }
    if (slot === "SUPPORT" && registered("OCCUPANT") !== null) {
        return { type: "DENIED", reason: "OCCUPIED" };
    }

    let buildableType = tile.buildableType;
    let advancedBuildableMask = tile.advancedBuildableMask ?? 0;
    let supportUnitId: Id | null = null;

    if (slot === "OCCUPANT") {
        const reference = registered("SUPPORT");

        if (reference !== null) {
            const provider = field.units.get(reference.id);

            if (
                provider === undefined ||
                !isSpatiallyPresent(provider) ||
                !hasTileBinding(provider)
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
