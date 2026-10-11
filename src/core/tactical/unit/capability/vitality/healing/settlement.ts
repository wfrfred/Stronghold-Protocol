import { hasStatusFlag } from "../../status/capability.js";
import { hasVitality, resolveVitalityMaxHp, type VitalUnit } from "../capability.js";
import { widenUnit, type StableUnit, type UnitId } from "../../../unit.js";
import type { Hook as RegisteredHook } from "../../../hook/hook.js";
import { resolveMaxHp } from "../query.js";
import type { Result } from "../hook.js";
import { resolveDamage, type Resources } from "../damage/settlement.js";
import { assertNonnegativeNumber } from "../../../../../common/assert.js";
import type { Context, Hook, Stage } from "./hook.js";
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
    state: BattleState,
    request: HealingRequest,
    resources: Resources,
): HealingReport {
    const { tick } = request;
    let pending: PendingHealing = {
        amount: Math.max(0, request.power),
        cancellation: null,
    };
    const target = getUnit(state, request.targetUnitId);

    if (target === undefined || !hasVitality(target) || target.vitality.hp <= 0) {
        const report = {
            request,
            amount: 0,
            cancellation: targetCancellation(state, request.targetUnitId),
        };
        notifyReactions(state, report, resources);

        return report;
    }

    if (request.skipModifierEvents !== true) {
        pending = applyHealingRules(
            state,
            request,
            request.sourceUnitId,
            "output",
            pending,
            resources,
        );
    }

    const cancellation = targetCancellation(state, request.targetUnitId);

    if (cancellation !== null) {
        pending = { ...pending, cancellation: pending.cancellation ?? cancellation };
    } else {
        const receiver = getUnit(state, request.targetUnitId)!;

        if (!request.ignoreHealFree && hasStatusFlag(receiver, "HEAL_FREE")) {
            pending = {
                ...pending,
                cancellation: pending.cancellation ?? { reason: "HEAL_FREE" },
            };
        }

        pending = applyHealingRules(
            state,
            request,
            request.targetUnitId,
            request.skipModifierEvents === true ? "skippedReception" : "reception",
            pending,
            resources,
        );
    }

    const healingAmount = pending.amount;

    assertNonnegativeNumber(healingAmount, "received healing");

    const current = getUnit(state, request.targetUnitId);
    const finalCancellation =
        pending.cancellation ?? targetCancellation(state, request.targetUnitId);
    let amount = 0;

    if (current !== undefined && hasVitality(current)) {
        let hp = current.vitality.hp;

        if (finalCancellation === null) {
            const maxHp = resolveMaxHp(current.id, battlefieldView(state))!;
            const healed = applyHealingValue(current, healingAmount, maxHp);
            updateUnit(state, healed.unit);
            amount = healed.amount;
            hp = healed.unit.vitality.hp;
        }

        appendEvents(state, [
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

    const report = { request, amount, cancellation: finalCancellation };
    notifyReactions(state, report, resources);

    return report;
}

interface StageHook<V> extends RegisteredHook<
    Context,
    V,
    Result<V> | { readonly stopDispatch?: boolean } | undefined
> {
    readonly priority: number;
}

function callHooks<V>(
    battle: BattleState,
    request: HealingRequest,
    ownerUnitId: UnitId | null,
    value: V,
    resources: Resources,
    select: (entry: Hook) => StageHook<V> | undefined,
): V {
    const unit = ownerUnitId === null ? undefined : getUnit(battle, ownerUnitId);

    if (unit === undefined || !hasVitality(unit)) {
        return value;
    }

    const previous = battle.activeVitalityHookSnapshots.get(unit.id);
    const snapshot = previous ?? {
        damage: unit.vitality.damageHooks,
        healing: unit.vitality.healingHooks,
    };
    battle.activeVitalityHookSnapshots.set(unit.id, snapshot);

    try {
        const candidates = snapshot.healing
            .flatMap((entry) => {
                const hook = select(entry);

                return hook === undefined ? [] : [{ entry, hook }];
            })
            .sort((left, right) => right.hook.priority - left.hook.priority);

        const invocation: Context = {
            battle,
            get unit() {
                return getUnit(battle, unit.id)!;
            },
            request,
            tick: request.tick,
            operations: {
                damage: (input) =>
                    resolveDamage(battle, { ...input, tick: request.tick }, resources),
                heal: (input) =>
                    resolveHealing(battle, { ...input, tick: request.tick }, resources),
            },
        };

        for (const { entry, hook } of candidates) {
            const current = getUnit(battle, unit.id);

            if (
                current === undefined ||
                !hasVitality(current) ||
                !current.vitality.healingHooks.includes(entry)
            ) {
                continue;
            }

            if (!hook.enabled(invocation)) {
                continue;
            }

            const result = hook.invoke(invocation, value);

            if (result !== undefined && "value" in result) {
                value = result.value;
            }

            if (result?.stopDispatch === true) {
                break;
            }
        }

        return value;
    } finally {
        if (previous === undefined) {
            battle.activeVitalityHookSnapshots.delete(unit.id);
        }
    }
}

function applyHealingRules(
    state: BattleState,
    request: HealingRequest,
    ownerUnitId: UnitId | null,
    stage: Stage,
    pending: PendingHealing,
    resources: Resources,
): PendingHealing {
    return callHooks(state, request, ownerUnitId, pending, resources, (entry) =>
        entry.stage !== "reaction" && entry.stage === stage ? entry : undefined,
    );
}

function notifyReactions(state: BattleState, report: HealingReport, resources: Resources): void {
    if (report.request.skipModifierEvents !== true) {
        const ownerUnitIds = new Set([report.request.targetUnitId, report.request.sourceUnitId]);

        for (const ownerUnitId of ownerUnitIds) {
            callHooks(state, report.request, ownerUnitId, report, resources, (entry) =>
                entry.stage === "reaction" ? entry : undefined,
            );
        }
    }
}

function targetCancellation(state: BattleState, targetUnitId: UnitId): HealingCancellation | null {
    const receiver = getUnit(state, targetUnitId);

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
