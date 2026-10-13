import type { BattlefieldChange } from "../../battlefield/contract.js";
import { evaluateDeployment } from "../../battlefield/deployment/query.js";
import type { SupportRelation } from "../../battlefield/support/relations.js";
import { Tile, type TilePosition } from "../../geometry/coordinate.js";
import { hasDeployable, type Deployable } from "../../unit/capability/deployable/capability.js";
import { hasDefinition as hasTileBindingDefinition } from "../../unit/capability/tile-binding/capability.js";
import {
    validateState as validateOccupancyState,
    hasOccupancy,
    type OccupancyClaim,
    type Occupancy,
    type State as OccupancyState,
} from "../../unit/capability/occupancy.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import { instantiateUnitPlacement, type UnitPlacementDefinition } from "../creation/placement.js";
import type { Unit, Id, Definition as UnitDefinition } from "../../unit/unit.js";
import type { Command } from "../contract.js";
import {
    enterUnits,
    removeUnitWithEffects,
    type UnitLifecycleResources,
} from "../execution/unit-lifecycle.js";
import {
    advanceBattlefield,
    appendEvents,
    battlefieldView,
    getUnit,
    type BattleState,
} from "../state.js";
import { notifyDeployed } from "../deployment/deployment.js";

export type DeploymentCommand =
    | {
          readonly type: "DEPLOY_UNIT";
          readonly definition: UnitDefinition & Deployable["definition"];
          readonly navigationModifiers?: UnitPlacementDefinition["navigationModifiers"];
          readonly tilePosition: TilePosition;
          readonly playerSide: "SIDE_A" | "SIDE_B";
      }
    | {
          readonly type: "RELOCATE_UNIT";
          readonly unitId: Id;
          readonly tilePosition: TilePosition;
          readonly playerSide: "SIDE_A" | "SIDE_B";
      }
    | { readonly type: "RETREAT_UNIT"; readonly unitId: Id };

export function resolveDeploymentCommands(
    state: BattleState,
    commands: readonly Command[],
    tick: number,
    resources: UnitLifecycleResources,
): BattleState {
    for (const command of commands) {
        if (
            command.type !== "DEPLOY_UNIT" &&
            command.type !== "RELOCATE_UNIT" &&
            command.type !== "RETREAT_UNIT"
        ) {
            continue;
        }

        if (command.type === "RETREAT_UNIT") {
            if (getUnit(state, command.unitId) === undefined) {
                throw new RangeError(`unknown retreat unit ${command.unitId}`);
            }

            state = removeUnitWithEffects(state, command.unitId, "RETREAT", resources, tick);
            continue;
        }

        const battlefield = battlefieldView(state);
        let existing: (Unit & Deployable & Occupancy) | undefined;
        let definition: UnitDefinition & Deployable["definition"];

        if (command.type === "DEPLOY_UNIT") {
            definition = command.definition;
        } else {
            const candidate = getUnit(state, command.unitId);

            if (
                candidate === undefined ||
                !hasDeployable(candidate) ||
                !hasOccupancy(candidate) ||
                !isSpatiallyPresent(candidate)
            ) {
                throw new RangeError(`unit ${command.unitId} cannot relocate`);
            }

            existing = candidate;
            definition = candidate.definition;
        }

        const slot = hasTileBindingDefinition(definition) ? "SUPPORT" : "DEPLOYMENT";
        const decision = evaluateDeployment(battlefield, {
            profile: definition.deployable,
            tile: command.tilePosition,
            playerSide: command.playerSide,
            slot,
            ...(existing === undefined ? {} : { relocatingUnitId: existing.id }),
        });

        if (decision.type === "DENIED") {
            throw new RangeError(`deployment denied: ${decision.reason}`);
        }

        const claims: OccupancyClaim[] =
            existing !== undefined
                ? existing.occupancy.claims.filter((claim) => claim.type === "RESERVATION")
                : [];
        const occupancy: OccupancyState = {
            claims: [...claims, { position: command.tilePosition, slot, type: "PRESENT" }],
        };
        validateOccupancyState(occupancy);
        const position = Tile.center(command.tilePosition);
        let unit: Unit & Deployable & Occupancy;
        const changes: BattlefieldChange[] = [];

        if (existing === undefined) {
            const placed = instantiateUnitPlacement(
                {
                    definition,
                    position,
                    states: { occupancy },
                    ...(command.type === "DEPLOY_UNIT" && command.navigationModifiers !== undefined
                        ? { navigationModifiers: command.navigationModifiers }
                        : {}),
                },
                state.execution,
                tick,
            );
            unit = placed.unit;
            state = { ...state, execution: placed.execution };
            changes.push(...placed.changes);
        } else {
            unit = { ...existing, position, occupancy };
            changes.push({ type: "UPDATE_UNIT", unit });
            changes.push({ type: "RELEASE_BLOCKING_RELATIONS", unitId: unit.id });
            state = appendEvents(state, [
                {
                    type: "UNIT_RELOCATED",
                    unitId: unit.id,
                    position,
                    tick,
                },
            ]);
        }

        let supports = battlefield.supportRelations.filter(
            (relation) => relation.supportedUnitId !== unit.id,
        );

        if (decision.supportUnitId !== null) {
            const relation: SupportRelation = {
                supportedUnitId: unit.id,
                supportUnitId: decision.supportUnitId,
            };
            supports = [...supports, relation];
        }

        state = advanceBattlefield(state, [
            ...changes,
            { type: "SET_SUPPORT_RELATIONS", relations: supports },
        ]);

        if (existing === undefined) {
            state = appendEvents(state, [
                { type: "UNIT_DEPLOYED", unitId: unit.id, position, tick },
            ]);
            state = enterUnits(state, [unit.id]);
            state = notifyDeployed(state, { unit, kind: "MANUAL" });
        }
    }

    return state;
}
