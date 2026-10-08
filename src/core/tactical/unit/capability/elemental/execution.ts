import {
    appendCombatEvents,
    getCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "../../../battle/execution/work.js";
import { drainUnitSkillSp } from "../../../battle/execution/skill-sp.js";
import type { UnitId } from "../../unit.js";
import type { EffectTransitionResources } from "../effects/contract.js";
import { EffectDispatchScope } from "../effects/dispatch.js";
import { createEffectOperations } from "../effects/operations.js";
import { effectView } from "../effects/query.js";
import type { DamageOperation } from "../vitality/hook.js";
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

function runBurst(
    work: CombatWork,
    burst: ElementalBurst,
    tick: number,
    previousTick: number,
    resources: ElementalExecutionResources,
    run: CompiledElementalBurst["begin"],
): CombatWork {
    let current = work;
    let active = true;
    const dispatch = new EffectDispatchScope();

    const readWork = () => {
        if (!active) {
            throw new TypeError("elemental context is no longer active");
        }

        return current;
    };

    const context: ElementalBurstContext = {
        burst,
        tick,
        previousTick,
        facts: effectView(readWork),
        effects: createEffectOperations(
            readWork,
            (next) => {
                current = next;
            },
            resources,
            tick,
            dispatch,
        ),
        damage: (request) => {
            const settled = resources.settleDamage(readWork(), { ...request, tick }, dispatch);
            current = settled.work;

            return settled.report;
        },
        drainSp: (amount) => {
            const drained = drainUnitSkillSp(readWork(), burst.targetUnitId, amount);
            current = drained.work;

            return drained.amount;
        },
    };

    try {
        run(context);

        return current;
    } finally {
        active = false;
    }
}

export function resolveElementDamage(
    work: CombatWork,
    request: ElementDamageRequest & { readonly targetUnitId: UnitId },
    resources: ElementalExecutionResources,
): { readonly work: CombatWork; readonly report: ElementDamageReport } {
    const unit = getCombatUnit(work, request.targetUnitId);

    if (unit === undefined) {
        return {
            work,
            report: { outcome: "REJECTED", reason: "TARGET_ABSENT", amount: 0, burst: null },
        };
    }

    const received = receiveElementDamage(unit, request);
    const { unit: next, ...report } = received;
    work = updateCombatUnit(work, next);

    if (received.outcome === "REJECTED") {
        return { work, report };
    }

    work = appendCombatEvents(work, [
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
        work = appendCombatEvents(work, [{ type: "ELEMENT_BURST", burst, tick: request.tick }]);
        work = runBurst(
            work,
            burst,
            request.tick,
            request.tick,
            resources,
            resources.elemental.get(burst.receiver, burst.type).begin,
        );
    }

    return { work, report };
}

export function resolveElementHeal(
    work: CombatWork,
    request: ElementHealRequest & {
        readonly targetUnitId: UnitId;
        readonly sourceUnitId: UnitId | null;
    },
): {
    readonly work: CombatWork;
    readonly amount: number;
    readonly outcome: "REJECTED" | "APPLIED";
} {
    const unit = getCombatUnit(work, request.targetUnitId);

    if (unit === undefined) {
        return { work, amount: 0, outcome: "REJECTED" };
    }

    const received = receiveElementHeal(unit, request);
    work = updateCombatUnit(work, received.unit);

    if (received.outcome === "APPLIED") {
        work = appendCombatEvents(work, [
            {
                type: "ELEMENT_HEAL",
                sourceUnitId: request.sourceUnitId,
                targetUnitId: unit.id,
                amounts: received.amounts,
                tick: request.tick,
            },
        ]);
    }

    return { work, amount: received.amount, outcome: received.outcome };
}

export function advanceElementalInWork(
    work: CombatWork,
    unitId: UnitId,
    tick: number,
    resources: ElementalExecutionResources,
): CombatWork {
    const unit = getCombatUnit(work, unitId);

    if (unit === undefined || !hasElemental(unit)) {
        return work;
    }

    const advanced = advanceElemental(unit, tick);
    work = updateCombatUnit(work, advanced.unit);

    if (advanced.burst !== null) {
        const program = resources.elemental.get(advanced.burst.receiver, advanced.burst.type);

        if (program.advance !== undefined) {
            work = runBurst(
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
        work = appendCombatEvents(work, [
            { type: "ELEMENT_RECOVERED", unitId, elementType: advanced.burst!.type, tick },
        ]);
    }

    return work;
}
