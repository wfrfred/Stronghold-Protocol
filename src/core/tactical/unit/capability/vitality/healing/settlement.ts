import { hasStatusFlag } from "../../status/capability.js";
import { EffectDispatchScope, participatingEffect } from "../../effects/dispatch.js";
import { effectView, getEffect } from "../../effects/query.js";
import { finalizeFinishedEffects } from "../../effects/lifecycle.js";
import type { EffectRef } from "../../effects/effect.js";
import { hasVitality, resolveVitalityMaxHp, type VitalUnit } from "../capability.js";
import { widenUnit, type StableUnit, type UnitId } from "../../../unit.js";
import { resolveMaxHp } from "../query.js";
import { withVitalityHookContext, type DispatchResult } from "../hook.js";
import { assertNonnegativeNumber } from "../../../../../common/assert.js";
import type {
    CompiledHealingContext,
    CompiledHealingRules,
    HealingResourceServices,
    HealingStage,
} from "./resources.js";
import type {
    HealingCancellation,
    HealingReport,
    HealingRequest,
    HealingResult,
    PendingHealing,
} from "./contract.js";
import {
    battlefieldView,
    appendEvents,
    getUnit,
    updateUnit,
    type BattleState,
} from "../../../../battle/execution/context.js";

interface CompiledHealingStage<V> {
    readonly priority: number;
    readonly apply: (context: CompiledHealingContext, value: V) => DispatchResult<V>;
}

interface HealingCandidate<V> {
    readonly ref: EffectRef;
    readonly acquiredSequence: number;
    readonly rule: CompiledHealingStage<V>;
}

function orderCandidates<V>(left: HealingCandidate<V>, right: HealingCandidate<V>): number {
    return (
        right.rule.priority - left.rule.priority ||
        left.acquiredSequence - right.acquiredSequence ||
        left.ref.effectId - right.ref.effectId
    );
}

function dispatchHealing<V>(
    work: BattleState,
    request: HealingRequest,
    ownerUnitId: UnitId | null,
    value: V,
    resources: HealingResourceServices,
    tick: number,
    scope: EffectDispatchScope,
    select: (rules: CompiledHealingRules) => CompiledHealingStage<V> | undefined,
): V {
    if (ownerUnitId === null) {
        return value;
    }

    const getWork = () => work;

    scope.withCandidates(effectView(getWork), ownerUnitId, (addresses) => {
        const candidates: HealingCandidate<V>[] = [];

        for (const ref of addresses) {
            const instance = getEffect(work, ref);
            const rule =
                instance === undefined ? undefined : select(resources.healing.get(instance));

            if (instance !== undefined && rule !== undefined) {
                candidates.push({
                    ref,
                    acquiredSequence: instance.acquiredSequence,
                    rule,
                });
            }
        }

        candidates.sort(orderCandidates);

        for (const candidate of candidates) {
            const instance = participatingEffect(effectView(getWork), candidate.ref);

            if (instance === undefined) {
                continue;
            }

            const result = withVitalityHookContext(
                getWork,
                candidate.ref,
                instance,
                request,
                resources,
                tick,
                scope,
                (context) => candidate.rule.apply(context, value),
            );
            value = result.value;

            if (result.stopDispatch === true) {
                break;
            }
        }
    });
    finalizeFinishedEffects(work, ownerUnitId, resources, tick, scope);

    return value;
}

function applyHealingRules(
    work: BattleState,
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
        pending,
        resources,
        tick,
        scope,
        (rules) => rules[stage],
    );
}

function confirmHealing(
    work: BattleState,
    report: HealingReport,
    resources: HealingResourceServices,
    tick: number,
    scope: EffectDispatchScope,
): HealingReport {
    report = Object.freeze(report);

    if (report.request.skipModifierEvents !== true) {
        const ownerUnitIds = new Set([report.request.targetUnitId, report.request.sourceUnitId]);

        for (const ownerUnitId of ownerUnitIds) {
            dispatchHealing(
                work,
                report.request,
                ownerUnitId,
                report,
                resources,
                tick,
                scope,
                (rules) => {
                    const reaction = rules.reaction;

                    return reaction === undefined
                        ? undefined
                        : {
                              priority: reaction.priority,
                              apply: (context, value) => {
                                  const outcome = reaction.apply(context, value);

                                  return outcome?.stopDispatch === true
                                      ? { value, stopDispatch: true }
                                      : { value };
                              },
                          };
                },
            );
        }
    }

    return report;
}

function targetCancellation(work: BattleState, targetUnitId: UnitId): HealingCancellation | null {
    const receiver = getUnit(work, targetUnitId);

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
    unit: U | StableUnit<U>,
    power: number,
    maxHp: number,
): HealingResult<U> {
    const amount = Math.max(0, Math.min(power, maxHp - unit.vitality.hp));

    return {
        unit: widenUnit<U>(
            amount === 0
                ? unit
                : { ...unit, vitality: { ...unit.vitality, hp: unit.vitality.hp + amount } },
        ),
        amount,
    };
}

export function healUnit<U extends VitalUnit>(
    unit: U | StableUnit<U>,
    power: number,
    ignoreHealFree = false,
    maxHp = resolveVitalityMaxHp(unit.definition.vitality, unit.vitality),
): HealingResult<U> {
    assertNonnegativeNumber(power, "healing amount");
    assertNonnegativeNumber(maxHp, "healing maximum HP");

    if (unit.vitality.hp <= 0 || (!ignoreHealFree && hasStatusFlag(unit, "HEAL_FREE"))) {
        return { unit: widenUnit<U>(unit), amount: 0 };
    }

    return applyHealingValue<U>(unit, power, maxHp);
}

export function resolveHealing(
    work: BattleState,
    request: HealingRequest,
    resources: HealingResourceServices,
    dispatch = new EffectDispatchScope(),
): HealingReport {
    const { tick } = request;
    let pending: PendingHealing = {
        amount: Math.max(0, request.power),
        cancellation: null,
    };
    const target = getUnit(work, request.targetUnitId);

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
        pending = applyHealingRules(
            work,
            request,
            request.sourceUnitId,
            "output",
            pending,
            resources,
            tick,
            dispatch,
        );
    }

    const cancellation = targetCancellation(work, request.targetUnitId);

    if (cancellation !== null) {
        pending = { ...pending, cancellation: pending.cancellation ?? cancellation };
    } else {
        const receiver = getUnit(work, request.targetUnitId)!;

        if (!request.ignoreHealFree && hasStatusFlag(receiver, "HEAL_FREE")) {
            pending = {
                ...pending,
                cancellation: pending.cancellation ?? { reason: "HEAL_FREE" },
            };
        }

        pending = applyHealingRules(
            work,
            request,
            request.targetUnitId,
            request.skipModifierEvents === true ? "skippedReception" : "reception",
            pending,
            resources,
            tick,
            dispatch,
        );
    }

    const healingAmount = pending.amount;

    assertNonnegativeNumber(healingAmount, "received healing");

    const current = getUnit(work, request.targetUnitId);
    const finalCancellation =
        pending.cancellation ?? targetCancellation(work, request.targetUnitId);
    let amount = 0;

    if (current !== undefined && hasVitality(current)) {
        let hp = current.vitality.hp;

        if (finalCancellation === null) {
            const maxHp = resolveMaxHp(current.id, battlefieldView(work))!;
            const healed = applyHealingValue(current, healingAmount, maxHp);
            updateUnit(work, healed.unit);
            amount = healed.amount;
            hp = healed.unit.vitality.hp;
        }

        appendEvents(work, [
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
