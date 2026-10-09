import type { ActionExecutionWork } from "../../unit/capability/action/internal/executions.js";
import type { BattlefieldChange, BattlefieldView } from "../../battlefield/contract.js";
import { evaluateDeployment, type DeploymentView } from "../../battlefield/deployment/query.js";
import {
    reconcileSupportRelations,
    type SupportRelation,
} from "../../battlefield/support/relations.js";
import { Tile, type TilePosition } from "../../geometry/coordinate.js";
import {
    hasDeploymentDefinition,
    hasTileBindingDefinition,
    type DeployableUnitDefinition,
} from "../../unit/capability/deployment.js";
import {
    createOccupancyState,
    hasOccupancy,
    isOccupancyClaimActive,
    type OccupancyClaim,
    type OccupancySlot,
    type Occupancy,
} from "../../unit/capability/occupancy.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import { instantiateUnitPlacement, type UnitPlacementDefinition } from "../creation/placement.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { Command, Event } from "../contract.js";
import type { BattleExecutionState } from "../execution/state.js";
import { removeUnitWithEffects, type UnitLifecycleResources } from "../execution/unit-lifecycle.js";
import {
    combatWorkEvents,
    combatWorkChanges,
    createCombatWork,
    updateCombatUnit,
    appendCombatEvents,
    withCombatExecution,
} from "../execution/work.js";

export type DeploymentCommand =
    | {
          readonly type: "DEPLOY_UNIT";
          readonly definition: DeployableUnitDefinition;
          readonly navigationModifiers?: UnitPlacementDefinition["navigationModifiers"];
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

interface DeploymentCommandResolution {
    readonly changes: readonly BattlefieldChange[];
    readonly events: readonly Event[];
    readonly execution: BattleExecutionState;
}

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

export function resolveDeploymentCommands(
    battlefield: BattlefieldView,
    commands: readonly Command[],
    execution: BattleExecutionState,
    tick: number,
    resources: UnitLifecycleResources,
    actionExecutions?: ActionExecutionWork,
): DeploymentCommandResolution {
    const deploymentCommands = commands.filter(
        (command) =>
            command.type === "DEPLOY_UNIT" ||
            command.type === "RELOCATE_UNIT" ||
            command.type === "RETREAT_UNIT",
    );

    if (deploymentCommands.length === 0) {
        return { changes: [], events: [], execution };
    }

    const units = new Map(battlefield.unitIds.map((id) => [id, battlefield.getUnit(id)!]));
    const view: DeploymentView = {
        map: battlefield.map,
        getUnit: (id) => units.get(id),
        occupancyAt: (position, slot) => occupancyAt(units, position, slot),
    };
    const changes: BattlefieldChange[] = [];
    let work = createCombatWork(battlefield, execution, battlefield, actionExecutions);
    let supports = battlefield.supportRelations;

    for (const command of deploymentCommands) {
        if (command.type === "RETREAT_UNIT") {
            if (!units.has(command.unitId)) {
                throw new RangeError(`unknown retreat unit ${command.unitId}`);
            }

            const previous = work;
            work = removeUnitWithEffects(work, command.unitId, "RETREAT", resources, tick);
            changes.push(...combatWorkChanges(work, previous));
            const exited = work;

            for (const unit of exited.unitUpdates.values()) {
                units.set(unit.id, unit);
            }
            for (const result of exited.lifecycleResults.slice(previous.lifecycleResults.length)) {
                if (result.type === "REMOVED") {
                    units.delete(result.unit.id);
                }
            }

            execution = exited.execution;
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
                    states: { occupancy },
                    ...(command.type === "DEPLOY_UNIT" && command.navigationModifiers !== undefined
                        ? { navigationModifiers: command.navigationModifiers }
                        : {}),
                },
                execution,
                tick,
            );
            unit = placed.unit;
            execution = placed.execution;
            changes.push(...placed.changes);
            work = appendCombatEvents(work, [
                { type: "UNIT_DEPLOYED", unitId: unit.id, position, tick },
            ]);
        } else {
            unit = { ...existing, position, occupancy };
            changes.push({ type: "UPDATE_UNIT", unit });
            changes.push({ type: "RELEASE_BLOCKING_RELATIONS", unitId: unit.id });
            work = appendCombatEvents(work, [
                {
                    type: "UNIT_RELOCATED",
                    unitId: unit.id,
                    position,
                    tick,
                },
            ]);
        }

        work = updateCombatUnit(withCombatExecution(work, execution), unit);
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

    return {
        changes,
        events: combatWorkEvents(work),
        execution: work.execution,
    };
}
