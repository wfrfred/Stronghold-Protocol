import {
    appendEvents,
    getUnit,
    updateUnit,
    type BattleState,
} from "../../../battle/execution/context.js";
import { drainUnitSkillSp } from "../../../battle/execution/skill-sp.js";
import type { UnitId } from "../../unit.js";
import type { EffectTransitionResources } from "../effects/contract.js";
import { EffectDispatchScope } from "../effects/dispatch.js";
import { createEffectOperations } from "../effects/operations.js";
import { effectView } from "../effects/query.js";
import type { DamageOperation } from "../vitality/damage/contract.js";
import { hasElemental, type ElementType, type ElementValues } from "./capability.js";
import type { ElementalRejection } from "./query.js";
import type { CompiledElementalBurst, ElementalBurstContext } from "./program.js";
import type { ElementalResources } from "./resources.js";
import {
    advanceElemental,
    receiveElementDamage,
    receiveElementHeal,
    type ElementalBurst,
    type ElementDamageRequest,
    type ElementHealRequest,
} from "./settlement.js";

export interface ElementalExecutionResources extends EffectTransitionResources {
    readonly elemental: ElementalResources;
    readonly settleDamage: DamageOperation;
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
    work: BattleState,
    request: ElementDamageRequest & { readonly targetUnitId: UnitId },
) => ElementDamageReport;

export type ElementHealOperation = (
    work: BattleState,
    request: ElementHealRequest & {
        readonly targetUnitId: UnitId;
        readonly sourceUnitId: UnitId | null;
    },
) => {
    readonly amount: number;
    readonly outcome: "REJECTED" | "APPLIED";
};

function runBurst(
    work: BattleState,
    burst: ElementalBurst,
    tick: number,
    previousTick: number,
    resources: ElementalExecutionResources,
    run: CompiledElementalBurst["begin"],
): void {
    let active = true;
    const dispatch = new EffectDispatchScope();

    const readWork = () => {
        if (!active) {
            throw new TypeError("elemental context is no longer active");
        }

        return work;
    };

    const context: ElementalBurstContext = {
        burst,
        tick,
        previousTick,
        facts: effectView(readWork),
        effects: createEffectOperations(readWork, resources, tick, dispatch),
        damage: (request) => {
            return resources.settleDamage(readWork(), { ...request, tick }, dispatch);
        },
        drainSp: (amount) => {
            return drainUnitSkillSp(readWork(), burst.targetUnitId, amount);
        },
    };

    try {
        run(context);
    } finally {
        active = false;
    }
}

export function resolveElementDamage(
    work: BattleState,
    request: ElementDamageRequest & { readonly targetUnitId: UnitId },
    resources: ElementalExecutionResources,
): ElementDamageReport {
    const unit = getUnit(work, request.targetUnitId);

    if (unit === undefined) {
        return { outcome: "REJECTED", reason: "TARGET_ABSENT", amount: 0, burst: null };
    }

    const received = receiveElementDamage(unit, request);
    const { unit: next, ...report } = received;
    updateUnit(work, next);

    if (received.outcome === "REJECTED") {
        return report;
    }

    appendEvents(work, [
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
        appendEvents(work, [{ type: "ELEMENT_BURST", burst, tick: request.tick }]);
        runBurst(
            work,
            burst,
            request.tick,
            request.tick,
            resources,
            resources.elemental.get(burst.receiver, burst.type).begin,
        );
    }

    return report;
}

export function resolveElementHeal(
    work: BattleState,
    request: ElementHealRequest & {
        readonly targetUnitId: UnitId;
        readonly sourceUnitId: UnitId | null;
    },
): {
    readonly amount: number;
    readonly outcome: "REJECTED" | "APPLIED";
} {
    const unit = getUnit(work, request.targetUnitId);

    if (unit === undefined) {
        return { amount: 0, outcome: "REJECTED" };
    }

    const received = receiveElementHeal(unit, request);
    updateUnit(work, received.unit);

    if (received.outcome === "APPLIED") {
        appendEvents(work, [
            {
                type: "ELEMENT_HEAL",
                sourceUnitId: request.sourceUnitId,
                targetUnitId: unit.id,
                amounts: received.amounts,
                tick: request.tick,
            },
        ]);
    }

    return { amount: received.amount, outcome: received.outcome };
}

export function advanceElementalState(
    work: BattleState,
    unitId: UnitId,
    tick: number,
    resources: ElementalExecutionResources,
): void {
    const unit = getUnit(work, unitId);

    if (unit === undefined || !hasElemental(unit)) {
        return;
    }

    const advanced = advanceElemental(unit, tick);
    updateUnit(work, advanced.unit);

    if (advanced.burst !== null) {
        const program = resources.elemental.get(advanced.burst.receiver, advanced.burst.type);

        if (program.advance !== undefined) {
            runBurst(
                work,
                advanced.burst,
                tick,
                unit.elemental.lastRecoveryTick,
                resources,
                program.advance,
            );
        }
    }
    if (advanced.recovered) {
        appendEvents(work, [
            { type: "ELEMENT_RECOVERED", unitId, elementType: advanced.burst!.type, tick },
        ]);
    }
}
