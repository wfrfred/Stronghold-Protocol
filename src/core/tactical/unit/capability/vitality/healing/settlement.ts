import { hasStatusFlag } from "../../status/capability.js";
import { hasVitality, resolveVitalityMaxHp, type VitalUnit } from "../capability.js";
import { widenUnit, type StableUnit, type UnitId } from "../../../unit.js";
import type { Hook as RegisteredHook } from "../../../hook/hook.js";
import { resolveMaxHp } from "../query.js";
import { context, withDispatch, type Dispatch, type Result } from "../hook.js";
import { assertNonnegativeNumber } from "../../../../../common/assert.js";
import type { Context, Hook, Services, Stage } from "./hook.js";
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

interface StageHook<V> extends RegisteredHook<Context, V, Result<V>> {
    readonly priority: number;
}

function dispatchHealing<V>(
    battle: BattleState,
    request: HealingRequest,
    ownerUnitId: UnitId | null,
    value: V,
    services: Services,
    dispatch: Dispatch,
    select: (entry: Hook) => StageHook<V> | undefined,
): V {
    const unit = ownerUnitId === null ? undefined : getUnit(battle, ownerUnitId);

    if (unit === undefined || !hasVitality(unit)) {
        return value;
    }

    return dispatch.withCandidates(unit, (snapshot) => {
        const candidates = snapshot.healing
            .flatMap((entry) => {
                const hook = select(entry);

                return hook === undefined ? [] : [{ entry, hook }];
            })
            .sort((left, right) => right.hook.priority - left.hook.priority);

        for (const { entry, hook } of candidates) {
            const current = getUnit(battle, unit.id);

            if (
                current === undefined ||
                !hasVitality(current) ||
                !current.vitality.healingHooks.includes(entry)
            ) {
                continue;
            }

            const invocation = context(battle, unit.id, request, services, dispatch);

            if (!hook.enabled(invocation)) {
                continue;
            }

            const result = hook.invoke(invocation, value);
            value = result.value;

            if (result.stopDispatch === true) {
                break;
            }
        }

        return value;
    });
}

function applyHealingRules(
    work: BattleState,
    request: HealingRequest,
    ownerUnitId: UnitId | null,
    stage: Stage,
    pending: PendingHealing,
    services: Services,
    dispatch: Dispatch,
): PendingHealing {
    return dispatchHealing(work, request, ownerUnitId, pending, services, dispatch, (entry) =>
        entry.stage !== "reaction" && entry.stage === stage ? entry : undefined,
    );
}

function confirmHealing(
    work: BattleState,
    report: HealingReport,
    services: Services,
    dispatch: Dispatch,
): HealingReport {
    if (report.request.skipModifierEvents !== true) {
        const ownerUnitIds = new Set([report.request.targetUnitId, report.request.sourceUnitId]);

        for (const ownerUnitId of ownerUnitIds) {
            dispatchHealing(
                work,
                report.request,
                ownerUnitId,
                report,
                services,
                dispatch,
                (entry) => {
                    if (entry.stage !== "reaction") {
                        return undefined;
                    }

                    return {
                        id: entry.id,
                        priority: entry.priority,
                        enabled: entry.enabled,
                        invoke: (invocation, value) => {
                            const outcome = entry.invoke(invocation, value);

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
    resources: Services,
    dispatch?: Dispatch,
): HealingReport {
    return withDispatch(work, dispatch, (scope) => settleHealing(work, request, resources, scope));
}

function settleHealing(
    work: BattleState,
    request: HealingRequest,
    resources: Services,
    dispatch: Dispatch,
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
        dispatch,
    );
}
