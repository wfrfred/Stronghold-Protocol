import { hasStatusFlag } from "../../status/capability.js";
import { EffectDispatchScope, participatingEffect } from "../../effects/dispatch.js";
import { effectFacts, getEffect } from "../../effects/query.js";
import { finalizeFinishedEffects } from "../../effects/lifecycle.js";
import type { EffectAddress } from "../../effects/instance.js";
import { hasVitality, resolveVitalityMaxHp, type VitalUnit } from "../capability.js";
import type { UnitId } from "../../../unit.js";
import { resolveMaxHp } from "../query.js";
import { withVitalityHookContext } from "../hook.js";
import { assertNonnegativeNumber } from "../../../../../common/assert.js";
import type { CompiledHealingContext, HealingResourceServices, HealingStage } from "./resources.js";
import type {
    HealingCancellation,
    HealingReport,
    HealingRequest,
    HealingResolution,
    HealingResult,
    PendingHealing,
} from "./contract.js";
import {
    combatWorkView,
    appendCombatEvents,
    getCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "../../../../battle/execution/work.js";

interface HealingCandidate {
    readonly address: EffectAddress;
    readonly priority: number;
    readonly acquiredSequence: number;
}

function orderCandidates(left: HealingCandidate, right: HealingCandidate): number {
    return (
        right.priority - left.priority ||
        left.acquiredSequence - right.acquiredSequence ||
        left.address.instanceId - right.address.instanceId
    );
}

function dispatchHealing<V>(
    work: CombatWork,
    request: HealingRequest,
    ownerUnitId: UnitId | null,
    stage: HealingStage | "reaction",
    value: V,
    resources: HealingResourceServices,
    tick: number,
    scope: EffectDispatchScope,
    run: (
        context: CompiledHealingContext,
        value: V,
    ) => { readonly value: V; readonly stopDispatch?: boolean },
): { readonly work: CombatWork; readonly value: V } {
    if (ownerUnitId === null) {
        return { work, value };
    }

    const getWork = () => work;

    const setWork = (current: CombatWork) => {
        work = current;
    };

    scope.withCandidates(effectFacts(getWork), ownerUnitId, (addresses) => {
        const candidates: HealingCandidate[] = [];

        for (const address of addresses) {
            const instance = getEffect(work, address);
            const rule =
                instance === undefined ? undefined : resources.healing.get(instance)[stage];

            if (instance !== undefined && rule !== undefined) {
                candidates.push({
                    address,
                    priority: rule.priority,
                    acquiredSequence: instance.acquiredSequence,
                });
            }
        }

        candidates.sort(orderCandidates);

        for (const candidate of candidates) {
            const instance = participatingEffect(effectFacts(getWork), candidate.address);

            if (instance === undefined) {
                continue;
            }

            const result = withVitalityHookContext(
                getWork,
                setWork,
                candidate.address,
                instance,
                request,
                resources,
                tick,
                scope,
                (context) => run(context, value),
            );
            value = result.value;

            if (result.stopDispatch === true) {
                break;
            }
        }
    });
    work = finalizeFinishedEffects(work, ownerUnitId, resources, tick, scope);

    return { work, value };
}

function applyHealingRules(
    work: CombatWork,
    request: HealingRequest,
    ownerUnitId: UnitId | null,
    stage: HealingStage,
    pending: PendingHealing,
    resources: HealingResourceServices,
    tick: number,
    scope: EffectDispatchScope,
) {
    return dispatchHealing(
        work,
        request,
        ownerUnitId,
        stage,
        pending,
        resources,
        tick,
        scope,
        (context, value) => resources.healing.get(context.instance)[stage]!.apply(context, value),
    );
}

function confirmHealing(
    work: CombatWork,
    report: HealingReport,
    resources: HealingResourceServices,
    tick: number,
    scope: EffectDispatchScope,
): HealingResolution {
    report = Object.freeze(report);

    if (report.request.skipModifierEvents !== true) {
        const ownerUnitIds = new Set([report.request.targetUnitId, report.request.sourceUnitId]);

        for (const ownerUnitId of ownerUnitIds) {
            const result = dispatchHealing(
                work,
                report.request,
                ownerUnitId,
                "reaction",
                report,
                resources,
                tick,
                scope,
                (context, value) => {
                    const outcome = resources.healing
                        .get(context.instance)
                        .reaction!.apply(context, value);

                    return outcome?.stopDispatch === true
                        ? { value, stopDispatch: true }
                        : { value };
                },
            );
            work = result.work;
        }
    }

    return { work, amount: report.amount, report };
}

function targetCancellation(work: CombatWork, targetUnitId: UnitId): HealingCancellation | null {
    const receiver = getCombatUnit(work, targetUnitId);

    if (receiver === undefined) {
        return { reason: "TARGET_ABSENT" };
    }
    if (!hasVitality(receiver)) {
        return { reason: "NO_VITALITY" };
    }
    if (receiver.vitality.hp <= 0) {
        return { reason: "TARGET_DEAD" };
    }

    return null;
}

function applyHealingValue<U extends VitalUnit>(
    unit: U,
    power: number,
    maxHp: number,
): HealingResult<U> {
    const amount = Math.max(0, Math.min(power, maxHp - unit.vitality.hp));

    return {
        unit:
            amount === 0
                ? unit
                : { ...unit, vitality: { ...unit.vitality, hp: unit.vitality.hp + amount } },
        amount,
    };
}

export function healUnit<U extends VitalUnit>(
    unit: U,
    power: number,
    ignoreHealFree = false,
    maxHp = resolveVitalityMaxHp(unit.definition.vitality, unit.vitality),
): HealingResult<U> {
    assertNonnegativeNumber(power, "healing amount");
    assertNonnegativeNumber(maxHp, "healing maximum HP");

    if (unit.vitality.hp <= 0 || (!ignoreHealFree && hasStatusFlag(unit, "HEAL_FREE"))) {
        return { unit, amount: 0 };
    }

    return applyHealingValue(unit, power, maxHp);
}

export function resolveHealing(
    work: CombatWork,
    request: HealingRequest,
    resources: HealingResourceServices,
    tick: number,
    dispatch = new EffectDispatchScope(),
): HealingResolution {
    let pending: PendingHealing = {
        amount: Math.max(0, request.power),
        cancellation: null,
    };
    const target = getCombatUnit(work, request.targetUnitId);

    if (target === undefined || !hasVitality(target) || target.vitality.hp <= 0) {
        return confirmHealing(
            work,
            { request, amount: 0, cancellation: targetCancellation(work, request.targetUnitId) },
            resources,
            tick,
            dispatch,
        );
    }

    if (request.skipModifierEvents !== true) {
        const output = applyHealingRules(
            work,
            request,
            request.sourceUnitId,
            "output",
            pending,
            resources,
            tick,
            dispatch,
        );
        work = output.work;
        pending = output.value;
    }

    const cancellation = targetCancellation(work, request.targetUnitId);

    if (cancellation !== null) {
        pending = { ...pending, cancellation: pending.cancellation ?? cancellation };
    } else {
        const receiver = getCombatUnit(work, request.targetUnitId)!;

        if (!request.ignoreHealFree && hasStatusFlag(receiver, "HEAL_FREE")) {
            pending = {
                ...pending,
                cancellation: pending.cancellation ?? { reason: "HEAL_FREE" },
            };
        }

        const reception = applyHealingRules(
            work,
            request,
            request.targetUnitId,
            request.skipModifierEvents === true ? "skippedReception" : "reception",
            pending,
            resources,
            tick,
            dispatch,
        );
        work = reception.work;
        pending = reception.value;
    }

    const healingAmount = pending.amount;

    assertNonnegativeNumber(healingAmount, "received healing");

    const current = getCombatUnit(work, request.targetUnitId);
    const finalCancellation =
        pending.cancellation ?? targetCancellation(work, request.targetUnitId);
    let amount = 0;

    if (current !== undefined && hasVitality(current)) {
        let hp = current.vitality.hp;

        if (finalCancellation === null) {
            const maxHp = resolveMaxHp(current.id, combatWorkView(work))!;
            const healed = applyHealingValue(current, healingAmount, maxHp);
            work = updateCombatUnit(work, healed.unit);
            amount = healed.amount;
            hp = healed.unit.vitality.hp;
        }

        work = appendCombatEvents(work, [
            {
                type: "HEAL",
                sourceUnitId: request.sourceUnitId,
                targetUnitId: request.targetUnitId,
                amount,
                hp,
                tick,
            },
        ]);
    }

    return confirmHealing(
        work,
        { request, amount, cancellation: finalCancellation },
        resources,
        tick,
        dispatch,
    );
}
