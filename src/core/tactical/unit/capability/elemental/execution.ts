import {
    appendEvents,
    battlefieldView,
    getUnit,
    updateUnit,
    type BattleState,
    type Result,
} from "../../../battle/state.js";
import { emptyCall, type CallContext } from "../../../battle/execution/call.js";
import type { UnitId } from "../../unit.js";
import { hasElemental, type ElementType, type ElementValues } from "./capability.js";
import type { ElementalRejection } from "./query.js";
import type { ElementalBurstContext } from "./definition.js";
import type { ElementalResources } from "./resources.js";
import {
    advanceElemental,
    receiveElementDamage,
    receiveElementHeal,
    type ElementalBurst,
    type ElementDamageRequest,
    type ElementHealRequest,
} from "./settlement.js";

export interface ElementalExecutionResources {
    readonly elemental: ElementalResources;
}

export type ElementalSignal =
    | {
          readonly type: "ELEMENT_DAMAGE";
          readonly sourceUnitId: UnitId | null;
          readonly targetUnitId: UnitId;
          readonly elementType: ElementType;
          readonly amount: number;
          readonly ep: number;
          readonly tick: number;
      }
    | {
          readonly type: "ELEMENT_HEAL";
          readonly sourceUnitId: UnitId | null;
          readonly targetUnitId: UnitId;
          readonly amounts: ElementValues;
          readonly tick: number;
      }
    | { readonly type: "ELEMENT_BURST"; readonly burst: ElementalBurst; readonly tick: number }
    | {
          readonly type: "ELEMENT_RECOVERED";
          readonly unitId: UnitId;
          readonly elementType: ElementType;
          readonly tick: number;
      };

export interface ElementDamageReport {
    readonly outcome: "REJECTED" | "APPLIED" | "BURST";
    readonly reason?: ElementalRejection | "TARGET_ABSENT";
    readonly amount: number;
    readonly burst: ElementalBurst | null;
}

export type ElementDamageOperation = (
    state: BattleState,
    request: ElementDamageRequest & { readonly targetUnitId: UnitId },
    call?: CallContext,
) => Result<ElementDamageReport>;

export type ElementHealOperation = (
    state: BattleState,
    request: ElementHealRequest & {
        readonly targetUnitId: UnitId;
        readonly sourceUnitId: UnitId | null;
    },
    call?: CallContext,
) => Result<ElementHealReport>;

export interface ElementHealReport {
    readonly amount: number;
    readonly outcome: "REJECTED" | "APPLIED";
}

function burstContext(
    state: BattleState,
    burst: ElementalBurst,
    tick: number,
    previousTick: number,
    call: CallContext,
): ElementalBurstContext {
    return { burst, tick, previousTick, facts: battlefieldView(state), call };
}

export function resolveElementDamage(
    state: BattleState,
    request: ElementDamageRequest & { readonly targetUnitId: UnitId },
    resources: ElementalExecutionResources,
    call: CallContext = emptyCall,
): Result<ElementDamageReport> {
    const unit = getUnit(state, request.targetUnitId);

    if (unit === undefined) {
        return {
            state,
            value: { outcome: "REJECTED", reason: "TARGET_ABSENT", amount: 0, burst: null },
        };
    }

    const received = receiveElementDamage(unit, request);
    const { unit: next, ...report } = received;
    state = updateUnit(state, next);

    if (received.outcome === "REJECTED") {
        return { state, value: report };
    }

    state = appendEvents(state, [
        {
            type: "ELEMENT_DAMAGE",
            sourceUnitId: request.sourceUnitId,
            targetUnitId: unit.id,
            elementType: request.type,
            amount: received.amount,
            ep: next.elemental!.ep[request.type],
            tick: request.tick,
        },
    ]);

    if (received.burst !== null) {
        const burst = received.burst;
        state = appendEvents(state, [{ type: "ELEMENT_BURST", burst, tick: request.tick }]);
        state = resources.elemental
            .get(burst.receiver, burst.type)
            .begin(state, burstContext(state, burst, request.tick, request.tick, call));
    }

    return { state, value: report };
}

export function resolveElementHeal(
    state: BattleState,
    request: ElementHealRequest & {
        readonly targetUnitId: UnitId;
        readonly sourceUnitId: UnitId | null;
    },
): Result<ElementHealReport> {
    const unit = getUnit(state, request.targetUnitId);

    if (unit === undefined) {
        return { state, value: { amount: 0, outcome: "REJECTED" } };
    }

    const received = receiveElementHeal(unit, request);
    state = updateUnit(state, received.unit);

    if (received.outcome === "APPLIED") {
        state = appendEvents(state, [
            {
                type: "ELEMENT_HEAL",
                sourceUnitId: request.sourceUnitId,
                targetUnitId: unit.id,
                amounts: received.amounts,
                tick: request.tick,
            },
        ]);
    }

    return { state, value: { amount: received.amount, outcome: received.outcome } };
}

export function advanceElementalState(
    state: BattleState,
    unitId: UnitId,
    tick: number,
    resources: ElementalExecutionResources,
    call: CallContext = emptyCall,
): BattleState {
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasElemental(unit)) {
        return state;
    }

    const advanced = advanceElemental(unit, tick);
    state = updateUnit(state, advanced.unit);

    if (advanced.burst !== null) {
        const definition = resources.elemental.get(advanced.burst.receiver, advanced.burst.type);

        if (definition.advance !== undefined) {
            state = definition.advance(
                state,
                burstContext(state, advanced.burst, tick, unit.elemental.lastRecoveryTick, call),
            );
        }
    }
    if (advanced.recovered) {
        state = appendEvents(state, [
            { type: "ELEMENT_RECOVERED", unitId, elementType: advanced.burst!.type, tick },
        ]);
    }

    return state;
}
