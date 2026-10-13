import { emptyCall, type CallContext } from "../../../../battle/execution/call.js";
import { hasStatusFlag } from "../../status/capability.js";
import { hasVitality, resolveVitalityMaxHp, type Vitality } from "../capability.js";
import type { Unit, Id } from "../../../unit.js";
import type { Hook as RegisteredHook } from "../../../hook/hook.js";
import { resolveMaxHp } from "../query.js";
import { hookScope, type Result } from "../hook.js";
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
    type Result as Settlement,
} from "../../../../battle/state.js";

function applyHealingValue(unit: Unit & Vitality, power: number, maxHp: number): HealingResult {
    const amount = Math.max(0, Math.min(power, maxHp - unit.vitality.hp));

    return {
        unit:
            amount === 0
                ? unit
                : { ...unit, vitality: { ...unit.vitality, hp: unit.vitality.hp + amount } },
        amount,
    };
}

export function healUnit(
    unit: Unit & Vitality,
    power: number,
    ignoreHealFree = false,
    maxHp = resolveVitalityMaxHp(unit.definition.vitality, unit.vitality),
): HealingResult {
    assertNonnegativeNumber(power, "healing amount");
    assertNonnegativeNumber(maxHp, "healing maximum HP");

    if (unit.vitality.hp <= 0 || (!ignoreHealFree && hasStatusFlag(unit, "HEAL_FREE"))) {
        return { unit, amount: 0 };
    }

    return applyHealingValue(unit, power, maxHp);
}

export function resolveHealing(
    state: BattleState,
    request: HealingRequest,
    call: CallContext = emptyCall,
): Settlement<HealingReport> {
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
        state = notifyReactions(state, report, call);

        return { state, value: report };
    }

    if (request.skipModifierEvents !== true) {
        const applied = applyHealingRules(
            state,
            request,
            request.sourceUnitId,
            "output",
            pending,
            call,
        );
        state = applied.state;
        pending = applied.value;
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

        const applied = applyHealingRules(
            state,
            request,
            request.targetUnitId,
            request.skipModifierEvents === true ? "skippedReception" : "reception",
            pending,
            call,
        );
        state = applied.state;
        pending = applied.value;
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
            state = updateUnit(state, healed.unit);
            amount = healed.amount;
            hp = healed.unit.vitality.hp;
        }

        state = appendEvents(state, [
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
    state = notifyReactions(state, report, call);

    return { state, value: report };
}

interface StageHook<V> extends RegisteredHook<
    BattleState,
    Context,
    V,
    Result<V> | { readonly stopDispatch?: boolean } | undefined
> {
    readonly priority: number;
}

function callHooks<V>(
    battle: BattleState,
    request: HealingRequest,
    ownerUnitId: Id | null,
    value: V,
    call: CallContext,
    select: (entry: Hook) => StageHook<V> | undefined,
): Settlement<V> {
    const unit = ownerUnitId === null ? undefined : getUnit(battle, ownerUnitId);

    if (unit === undefined || !hasVitality(unit)) {
        return { state: battle, value };
    }

    const scope = hookScope(unit, call);
    const candidates = scope.candidates.healing
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

        const context: Context = {
            unit: current,
            battlefield: battlefieldView(battle),
            request,
            tick: request.tick,
            call: scope.call,
        };

        if (!hook.enabled(context)) {
            continue;
        }

        const invoked = hook.invoke(battle, context, value);
        battle = invoked.state;
        const result = invoked.value;

        if (result !== undefined && "value" in result) {
            value = result.value;
        }
        if (result?.stopDispatch === true) {
            break;
        }
    }

    return { state: battle, value };
}

function applyHealingRules(
    state: BattleState,
    request: HealingRequest,
    ownerUnitId: Id | null,
    stage: Stage,
    pending: PendingHealing,
    call: CallContext,
): Settlement<PendingHealing> {
    return callHooks(state, request, ownerUnitId, pending, call, (entry) =>
        entry.stage !== "reaction" && entry.stage === stage ? entry : undefined,
    );
}

function notifyReactions(
    state: BattleState,
    report: HealingReport,
    call: CallContext,
): BattleState {
    if (report.request.skipModifierEvents !== true) {
        for (const owner of new Set([report.request.targetUnitId, report.request.sourceUnitId])) {
            state = callHooks(state, report.request, owner, report, call, (entry) =>
                entry.stage === "reaction" ? entry : undefined,
            ).state;
        }
    }

    return state;
}

function targetCancellation(state: BattleState, targetUnitId: Id): HealingCancellation | null {
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
