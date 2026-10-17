import { assertNonnegativeNumber } from "../../../common/assert.js";
import type { Ref } from "../../../common/ref.js";
import type { Unit } from "../../unit/unit.js";
import * as units from "../../unit/query.js";
import { resolveMaxHp } from "../../unit/capability/vitality/capability.js";
import { appendEvents, updateUnit, type Result, type State as BattleState } from "../state.js";
import type {
    ApplicationResult,
    CalculatedHealing,
    HealingOutcome,
    HealingRequest,
    PendingHealing,
} from "./contract.js";
import { dispatch, type ReceivingContext } from "./hook.js";

export function applyHealing(
    request: HealingRequest,
    calculated: Result<CalculatedHealing | undefined>,
): Result<HealingOutcome> {
    let battle = calculated.state;
    const healing = calculated.value;

    if (healing === undefined) {
        return complete(battle, request, healing, { kind: "REJECTED" });
    }

    assertNonnegativeNumber(healing.amount, "output healing");
    const context = { request, calculated: healing };

    if (!canReceive(battle, request)) {
        return complete(battle, request, healing, { kind: "REJECTED" });
    }

    battle = dispatch(battle, request.target, context, undefined, (entry) =>
        entry.stage === "receivingStarted" ? entry : undefined,
    ).state;
    const receiving = dispatch<ReceivingContext, PendingHealing>(
        battle,
        request.target,
        context,
        { amount: healing.amount, cancellation: null },
        (entry) => (entry.stage === "receiving" ? entry : undefined),
    );
    battle = receiving.state;
    const received = receiving.value;
    assertNonnegativeNumber(received.amount, "received healing");

    if (received.cancellation !== null) {
        return complete(battle, request, healing, { kind: "CANCELLED", received });
    }
    if (!canReceive(battle, request)) {
        return complete(battle, request, healing, { kind: "UNAVAILABLE", received });
    }

    const target = units.get(battle, request.target)!;
    const hpBefore = target.vitality.hp;
    const maxHp = resolveMaxHp(target.definition.vitality, target.vitality);
    const amount = Math.max(0, Math.min(received.amount, maxHp - hpBefore));
    const hpAfter = hpBefore + amount;
    const application: ApplicationResult = { hpBefore, hpAfter, hpGain: hpAfter - hpBefore };

    if (hpAfter !== hpBefore) {
        battle = updateUnit(battle, { ...target, vitality: { ...target.vitality, hp: hpAfter } });
    }

    battle = appendEvents(battle, [
        {
            type: "HEAL",
            sourceUnitId: request.source?.id ?? null,
            targetUnitId: request.target.id,
            amount: application.hpGain,
            receivedAmount: received.amount,
            cancellation: null,
            hp: hpAfter,
            tick: battle.tick,
        },
    ]);

    for (const owner of observers(request)) {
        battle = dispatch(
            battle,
            owner,
            { ...context, received, application },
            undefined,
            (entry) => (entry.stage === "hpApplied" ? entry : undefined),
        ).state;
    }

    return complete(battle, request, healing, { kind: "APPLIED", received, application });
}

function canReceive(battle: BattleState, request: HealingRequest): boolean {
    const target = units.get(battle, request.target);

    return target?.lifecycle === "PRESENT" && target.vitality.hp > 0;
}

function observers(request: HealingRequest): readonly Ref<Unit>[] {
    return request.source !== null && request.source.id !== request.target.id
        ? [request.target, request.source]
        : [request.target];
}

function complete(
    battle: BattleState,
    request: HealingRequest,
    calculated: CalculatedHealing | undefined,
    outcome: HealingOutcome,
): Result<HealingOutcome> {
    if (outcome.kind === "CANCELLED" && calculated !== undefined) {
        const target = units.get(battle, request.target);
        battle = appendEvents(battle, [
            {
                type: "HEAL",
                sourceUnitId: request.source?.id ?? null,
                targetUnitId: request.target.id,
                amount: 0,
                receivedAmount: outcome.received.amount,
                cancellation: outcome.received.cancellation,
                hp: target?.vitality.hp ?? null,
                tick: battle.tick,
            },
        ]);
    }

    for (const owner of observers(request)) {
        battle = dispatch(battle, owner, { request, calculated, outcome }, undefined, (entry) =>
            entry.stage === "completed" ? entry : undefined,
        ).state;
    }

    return { state: battle, value: outcome };
}
