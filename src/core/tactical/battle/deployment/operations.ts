import { evaluateDeployment } from "../../battlefield/deployment/query.js";
import * as blocking from "../blocking/operations.js";
import * as battlefield from "../../battlefield/state.js";
import { Tile, type TilePosition } from "../../geometry/coordinate.js";
import { hasDeployable, type Deployable } from "../../unit/capability/deployable/capability.js";
import { hasDefinition as hasTileBindingDefinition } from "../../unit/capability/tile-binding/capability.js";
import { hasOccupancy, type Occupancy } from "../../unit/capability/occupancy/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import { instantiateUnitPlacement } from "../creation/placement.js";
import type { Unit, Id } from "../../unit/unit.js";
import * as unitQueries from "../../unit/query.js";
import type { Command } from "../contract.js";
import { enter, leave } from "../execution/unit.js";
import {
    setBattlefield,
    appendEvents,
    registerUnit,
    getUnit,
    type State as BattleState,
    type Result,
} from "../state.js";
import { changeDp, getCard, notifyDeployed, updateCard, usedSlots } from "./deployment.js";
import * as card from "./card.js";

export interface DeployRequest {
    readonly cardId: card.Id;
    readonly tilePosition: TilePosition;
    readonly playerSide: "SIDE_A" | "SIDE_B";
}

export type DeploymentCommand =
    | ({ readonly type: "DEPLOY_UNIT" } & DeployRequest)
    | {
          readonly type: "RELOCATE_UNIT";
          readonly unitId: Id;
          readonly tilePosition: TilePosition;
          readonly playerSide: "SIDE_A" | "SIDE_B";
      }
    | { readonly type: "RETREAT_UNIT"; readonly unitId: Id };

export type Rejection =
    | "UNKNOWN_CARD"
    | "NO_STOCK"
    | "COOLDOWN"
    | "ACTIVE_LIMIT"
    | "SLOT_LIMIT"
    | "INSUFFICIENT_DP"
    | Extract<ReturnType<typeof evaluateDeployment>, { readonly type: "DENIED" }>["reason"];

export type DeployOutcome =
    | { readonly type: "DEPLOYED"; readonly cardId: card.Id; readonly unitId: Id }
    | { readonly type: "REJECTED"; readonly reason: Rejection };

export function deploy(state: BattleState, request: DeployRequest): Result<DeployOutcome> {
    let value = getCard(state, request.cardId);
    const reject = (reason: Rejection): Result<DeployOutcome> => ({
        state,
        value: { type: "REJECTED", reason },
    });

    if (value === undefined) {
        return reject("UNKNOWN_CARD");
    }

    value = card.advance(value, state.tick);
    state = updateCard(state, value);

    if (value.stock === 0) {
        return reject("NO_STOCK");
    }
    if (value.definition.supply.recharge !== "QUEUED" && value.cooldown !== null) {
        return reject("COOLDOWN");
    }

    const activeLimit = value.definition.supply.activeLimit;
    const active = [...state.battlefield.units.values()].filter(
        (unit) => hasDeployable(unit) && unit.deployable.cardId === request.cardId,
    ).length;

    if (activeLimit !== null && active >= activeLimit) {
        return reject("ACTIVE_LIMIT");
    }

    const definition = value.definition.unit;
    const slotLimit = state.deployment.definition.slotLimit;

    if (slotLimit !== null && usedSlots(state) + definition.deployable.slots > slotLimit) {
        return reject("SLOT_LIMIT");
    }

    const cost = card.resolveCost(value);

    if (state.deployment.dp < cost) {
        return reject("INSUFFICIENT_DP");
    }

    const slot = hasTileBindingDefinition(definition) ? "SUPPORT" : "OCCUPANT";
    const decision = evaluateDeployment(state.battlefield, {
        profile: definition.deployable,
        tile: request.tilePosition,
        playerSide: request.playerSide,
        slot,
    });

    if (decision.type === "DENIED") {
        return reject(decision.reason);
    }

    const placed = instantiateUnitPlacement(state, {
        definition,
        position: Tile.center(request.tilePosition),
        registration: { tile: request.tilePosition, slot },
    });
    state = placed.state;
    const unit = {
        ...placed.value,
        deployable: {
            ...placed.value.deployable,
            cardId: value.id,
            cost,
            refundLimit:
                definition.deployable.refund.limit === "DEPLOYMENT_COST"
                    ? cost
                    : card.resolveBaseCost(value),
            refundAllowed: true,
        },
    };
    state = updateCard(state, card.advance(card.consume(value, state.tick), state.tick));
    state = {
        ...state,
        deployment: changeDp(state.deployment, -cost, state.tick),
    };
    state = registerUnit(state, unit);
    state = appendEvents(state, [
        {
            type: "UNIT_DEPLOYED",
            unitId: unit.id,
            position: unit.position,
            tick: state.tick,
        },
    ]);
    state = enter(state, unit.id);
    state = notifyDeployed(state, { unit, kind: "MANUAL" });

    return { state, value: { type: "DEPLOYED", cardId: value.id, unitId: unit.id } };
}

export function retreat(state: BattleState, unitId: Id): BattleState {
    if (getUnit(state, unitId) === undefined) {
        throw new RangeError(`unknown retreat unit ${unitId}`);
    }

    return leave(state, unitId, "RETREAT");
}

export function relocate(
    state: BattleState,
    request: {
        readonly unitId: Id;
        readonly tilePosition: TilePosition;
        readonly playerSide: "SIDE_A" | "SIDE_B";
    },
): BattleState {
    const unit = getUnit(state, request.unitId);

    if (
        unit === undefined ||
        !hasDeployable(unit) ||
        !hasOccupancy(unit) ||
        !isSpatiallyPresent(unit)
    ) {
        throw new RangeError(`unit ${request.unitId} cannot relocate`);
    }

    const slot = hasTileBindingDefinition(unit.definition) ? "SUPPORT" : "OCCUPANT";
    const decision = evaluateDeployment(state.battlefield, {
        profile: unit.definition.deployable,
        tile: request.tilePosition,
        playerSide: request.playerSide,
        slot,
        relocatingUnitId: unit.id,
    });

    if (decision.type === "DENIED") {
        throw new RangeError(`relocation denied: ${decision.reason}`);
    }

    const moved: Unit & Deployable & Occupancy = {
        ...unit,
        position: Tile.center(request.tilePosition),
        occupancy: {
            registration: { tile: request.tilePosition, slot },
        },
    };
    const relations = blocking.capture(state, unitQueries.ref(unit));
    state = setBattlefield(state, battlefield.replaceUnit(state.battlefield, moved));
    state = blocking.releaseCaptured(state, relations);
    state = blocking.maintain(state);

    return appendEvents(state, [
        { type: "UNIT_RELOCATED", unitId: unit.id, position: moved.position, tick: state.tick },
    ]);
}

export function resolveDeploymentCommands(
    state: BattleState,
    commands: readonly Command[],
): BattleState {
    for (const command of commands) {
        if (command.type === "DEPLOY_UNIT") {
            const result = deploy(state, command);
            state = result.state;

            if (result.value.type === "REJECTED") {
                state = appendEvents(state, [
                    {
                        type: "DEPLOYMENT_REJECTED",
                        cardId: command.cardId,
                        reason: result.value.reason,
                        tick: state.tick,
                    },
                ]);
            }
        } else if (command.type === "RETREAT_UNIT") {
            state = retreat(state, command.unitId);
        } else if (command.type === "RELOCATE_UNIT") {
            state = relocate(state, command);
        }
    }

    return state;
}
