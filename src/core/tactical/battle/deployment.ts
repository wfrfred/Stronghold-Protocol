import type { BattlefieldChange } from "../battlefield/runtime.js";
import { evaluateDeployment, type DeploymentView } from "../battlefield/deployment.js";
import { reconcileSupportRelations, type SupportRelation } from "../battlefield/support.js";
import { Tile, type TilePosition } from "../geometry/coordinate.js";
import {
    hasDeploymentDefinition,
    hasTileBindingDefinition,
    type DeployableUnitDefinition,
} from "../unit/capability/deployment.js";
import {
    createOccupancyState,
    hasOccupancy,
    isOccupancyClaimActive,
    type OccupancyClaim,
    type OccupancySlot,
    type Occupancy,
} from "../unit/capability/occupancy.js";
import { isSpatiallyPresent } from "../unit/capability/presence.js";
import { instantiateUnitPlacement, type UnitPlacementDefinition } from "./unit-creation.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { BattleEvent } from "./contract.js";
import type { BattlePhase } from "./system.js";

export type DeploymentCommand =
    | {
          readonly type: "DEPLOY_UNIT";
          readonly definition: DeployableUnitDefinition;
          readonly navigationEffects?: UnitPlacementDefinition["navigationEffects"];
          readonly tilePosition: TilePosition;
          readonly playerSide: "SIDE_A" | "SIDE_B";
      }
    | {
          readonly type: "RELOCATE_UNIT";
          readonly unitId: UnitId;
          readonly tilePosition: TilePosition;
          readonly playerSide: "SIDE_A" | "SIDE_B";
      }
    | { readonly type: "RETREAT_UNIT"; readonly unitId: UnitId };

function occupancyAt(
    units: ReadonlyMap<UnitId, Unit>,
    position: TilePosition,
    slot: OccupancySlot,
): readonly UnitId[] {
    const ids: UnitId[] = [];

    for (const unit of units.values()) {
        if (
            hasOccupancy(unit) &&
            unit.occupancy.claims.some(
                (claim) =>
                    claim.slot === slot &&
                    claim.position[0] === position[0] &&
                    claim.position[1] === position[1] &&
                    isOccupancyClaimActive(unit, claim),
            )
        ) {
            ids.push(unit.id);
        }
    }

    return ids;
}

export function createDeploymentSystem(): { readonly step: BattlePhase } {
    const step: BattlePhase = (input) => {
        const commands = input.commands.filter(
            (command): command is DeploymentCommand =>
                command.type === "DEPLOY_UNIT" ||
                command.type === "RELOCATE_UNIT" ||
                command.type === "RETREAT_UNIT",
        );

        if (commands.length === 0) {
            return { state: undefined, changes: [], events: [], execution: input.execution };
        }

        const units = new Map(
            input.battlefield.unitIds.map((id) => [id, input.battlefield.getUnit(id)!]),
        );
        const view: DeploymentView = {
            map: input.battlefield.map,
            getUnit: (id) => units.get(id),
            occupancyAt: (position, slot) => occupancyAt(units, position, slot),
        };
        const changes: BattlefieldChange[] = [];
        const events: BattleEvent[] = [];
        let supports = input.battlefield.supportRelations;
        let execution = input.execution;

        for (const command of commands) {
            if (command.type === "RETREAT_UNIT") {
                if (!units.has(command.unitId)) {
                    throw new RangeError(`unknown retreat unit ${command.unitId}`);
                }

                units.delete(command.unitId);
                changes.push({ type: "REMOVE_UNIT", unitId: command.unitId, reason: "RETREAT" });
                continue;
            }

            let existing: (Unit & Occupancy) | undefined;
            let definition: DeployableUnitDefinition;

            if (command.type === "DEPLOY_UNIT") {
                definition = command.definition;
            } else {
                const candidate = units.get(command.unitId);

                if (
                    candidate === undefined ||
                    !hasDeploymentDefinition(candidate.definition) ||
                    !hasOccupancy(candidate) ||
                    !isSpatiallyPresent(candidate)
                ) {
                    throw new RangeError(`unit ${command.unitId} cannot relocate`);
                }

                existing = candidate;
                definition = candidate.definition;
            }

            const slot = hasTileBindingDefinition(definition) ? "SUPPORT" : "DEPLOYMENT";
            const decision = evaluateDeployment(view, {
                profile: definition.deployment,
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
            const occupancy = createOccupancyState({
                claims: [...claims, { position: command.tilePosition, slot, type: "PRESENT" }],
            });
            const position = Tile.center(command.tilePosition);
            let unit: Unit & Occupancy;

            if (existing === undefined) {
                const placed = instantiateUnitPlacement(
                    {
                        definition,
                        position,
                        occupancy,
                        ...(command.type === "DEPLOY_UNIT" &&
                        command.navigationEffects !== undefined
                            ? { navigationEffects: command.navigationEffects }
                            : {}),
                    },
                    execution,
                    input.tick,
                );
                unit = placed.unit;
                execution = placed.execution;
                changes.push(...placed.changes);
                events.push({ type: "UNIT_DEPLOYED", unitId: unit.id, position, tick: input.tick });
            } else {
                unit = { ...existing, position, occupancy };
                changes.push({ type: "UPDATE_UNIT", unit });
                changes.push({ type: "RELEASE_BLOCKING_RELATIONS", unitId: unit.id });
                events.push({
                    type: "UNIT_RELOCATED",
                    unitId: unit.id,
                    position,
                    tick: input.tick,
                });
            }

            units.set(unit.id, unit);
            supports = supports.filter((relation) => relation.supportedUnitId !== unit.id);

            if (decision.supportUnitId !== null) {
                const relation: SupportRelation = {
                    supportedUnitId: unit.id,
                    supportUnitId: decision.supportUnitId,
                };
                supports = [...supports, relation];
            }
        }

        changes.push({
            type: "SET_SUPPORT_RELATIONS",
            relations: reconcileSupportRelations(units, supports),
        });

        return { state: undefined, changes, events, execution };
    };

    return { step };
}
