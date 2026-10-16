import { receptionCancellation } from "./reception.js";
import * as units from "../../../query.js";
import { hasVitality, type Vitality } from "../capability.js";
import type { Id, Unit } from "../../../unit.js";
import { dispatch, type Hook as RegisteredHook } from "../../../hook/hook.js";
import { resolveMaxHp } from "../query.js";
import type { Control } from "../hook.js";
import type { Ref } from "../../../../../common/ref.js";
import { assertNonnegativeNumber } from "../../../../../common/assert.js";
import type { Context, Hook, Stage, ReactionContext } from "./hook.js";
import type {
    HealingCancellation,
    HealingReport,
    HealingRequest,
    PendingHealing,
} from "./contract.js";
import {
    battlefieldView,
    appendEvents,
    getUnit,
    updateUnit,
    type State as BattleState,
    type Result as Settlement,
} from "../../../../battle/state.js";

export function resolveHealing(
    state: BattleState,
    request: HealingRequest,
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
        state = notifyReactions(state, report);

        return { state, value: report };
    }

    if (request.skipModifierEvents !== true) {
        const applied = applyHealingRules(state, request, request.sourceUnitId, "output", pending);
        state = applied.state;
        pending = applied.value;
    }

    const cancellation = targetCancellation(state, request.targetUnitId);

    if (cancellation !== null) {
        pending = { ...pending, cancellation: pending.cancellation ?? cancellation };
    } else {
        const receiver = getUnit(state, request.targetUnitId)!;

        const cancellation = receptionCancellation({
            source:
                request.sourceUnitId === null ? undefined : getUnit(state, request.sourceUnitId),
            target: receiver,
            battlefield: battlefieldView(state),
            ignoreHealFree: request.ignoreHealFree,
            request,
        });

        if (cancellation !== null) {
            pending = {
                ...pending,
                cancellation: pending.cancellation ?? cancellation,
            };
        }

        const applied = applyHealingRules(
            state,
            request,
            request.targetUnitId,
            request.skipModifierEvents === true ? "skippedReception" : "reception",
            pending,
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
            amount = Math.max(0, Math.min(healingAmount, maxHp - hp));
            hp += amount;

            if (amount !== 0) {
                state = updateUnit(state, { ...current, vitality: { ...current.vitality, hp } });
            }
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
    state = notifyReactions(state, report);

    return { state, value: report };
}

interface StageHook<C, V> extends RegisteredHook<C, V> {
    readonly priority: number;
}

function callHooks<C, V extends Control>(
    battle: BattleState,
    owner: Id | null,
    context: (host: Ref<Unit & Vitality>) => C,
    value: V,
    select: (entry: Hook) => StageHook<C, V> | undefined,
): Settlement<V> {
    const unit = owner === null ? undefined : getUnit(battle, owner);

    if (unit === undefined || !hasVitality(unit)) {
        return { state: battle, value };
    }

    const host = units.ref(unit);

    return dispatch(
        battle,
        context(host),
        { ...value, stopDispatch: false },
        {
            candidates(current) {
                const self = units.get(current, host);

                if (self === undefined) {
                    return [];
                }

                return self.vitality.healingHooks
                    .flatMap((entry) => {
                        const hook = select(entry);

                        return hook === undefined
                            ? []
                            : [{ id: entry.id, priority: hook.priority }];
                    })
                    .sort((left, right) => right.priority - left.priority)
                    .map(({ id }) => id);
            },
            find(current, id) {
                const self = units.get(current, host);

                if (self === undefined) {
                    return undefined;
                }

                const entry = self.vitality.healingHooks.find((candidate) => candidate.id === id);

                return entry === undefined ? undefined : select(entry);
            },
            stop: (_current, value) => value.stopDispatch === true,
        },
    );
}

function applyHealingRules(
    battle: BattleState,
    request: HealingRequest,
    owner: Id | null,
    stage: Stage,
    pending: PendingHealing,
): Settlement<PendingHealing> {
    const result = callHooks<Context, PendingHealing & Control>(
        battle,
        owner,
        (host) => ({ host, request }),
        pending,
        (entry) => (entry.stage !== "reaction" && entry.stage === stage ? entry : undefined),
    );
    const { amount, cancellation } = result.value;

    return { state: result.state, value: { amount, cancellation } };
}

function notifyReactions(state: BattleState, report: HealingReport): BattleState {
    if (report.request.skipModifierEvents !== true) {
        for (const owner of new Set([report.request.targetUnitId, report.request.sourceUnitId])) {
            state = callHooks<ReactionContext, Control>(
                state,
                owner,
                (host) => ({ host, request: report.request, report }),
                {},
                (entry) => (entry.stage === "reaction" ? entry : undefined),
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
