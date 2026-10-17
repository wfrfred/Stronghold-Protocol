import { assertNonnegativeNumber } from "../../../common/assert.js";
import type { Ref } from "../../../common/ref.js";
import type { Unit } from "../../unit/unit.js";
import * as units from "../../unit/query.js";
import { appendEvents, updateUnit, type Result, type State as BattleState } from "../state.js";
import { leave } from "../execution/unit.js";
import type {
    ApplicationResult,
    CalculatedDamage,
    DamageOutcome,
    DamageRequest,
    PendingDamage,
} from "./contract.js";
import { dispatch, type ReceivingContext } from "./hook.js";

export function applyDamage(
    request: DamageRequest,
    calculated: Result<CalculatedDamage | undefined>,
): Result<DamageOutcome> {
    let battle = calculated.state;
    const damage = calculated.value;

    if (damage === undefined) {
        return complete(battle, request, damage, { kind: "REJECTED" });
    }

    assertNonnegativeNumber(damage.amount, "output damage");
    const context = { request, calculated: damage };

    if (damage.amount === 0 || !canReceive(battle, context)) {
        return complete(battle, request, damage, { kind: "REJECTED" });
    }

    battle = dispatch(battle, request.target, context, undefined, (entry) =>
        entry.stage === "receivingStarted" ? entry : undefined,
    ).state;
    const receiving = dispatch<ReceivingContext, PendingDamage>(
        battle,
        request.target,
        context,
        { amount: damage.amount, cancellation: null },
        (entry) => (entry.stage === "receiving" ? entry : undefined),
    );
    battle = receiving.state;
    const received = receiving.value;
    assertNonnegativeNumber(received.amount, "received damage");

    if (received.cancellation !== null) {
        return complete(battle, request, damage, { kind: "CANCELLED", received });
    }
    if (!canReceive(battle, context)) {
        return complete(battle, request, damage, { kind: "UNAVAILABLE", received });
    }

    const target = units.get(battle, request.target)!;
    const hpBefore = target.vitality.hp;
    const hpAfter = Math.max(0, hpBefore - received.amount);
    const application: ApplicationResult = { hpBefore, hpAfter, hpLoss: hpBefore - hpAfter };

    if (hpAfter !== hpBefore) {
        battle = updateUnit(battle, { ...target, vitality: { ...target.vitality, hp: hpAfter } });
    }

    battle = appendEvents(battle, [
        {
            type: "DAMAGE",
            sourceUnitId: request.source?.id ?? null,
            targetUnitId: request.target.id,
            damageType: damage.type,
            amount: application.hpLoss,
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

    const current = units.get(battle, request.target);

    if (current?.lifecycle === "PRESENT" && current.vitality.hp <= 0) {
        battle = leave(battle, request.target.id, "DEATH");
    }

    return complete(battle, request, damage, { kind: "APPLIED", received, application });
}

function canReceive(battle: BattleState, context: ReceivingContext): boolean {
    const target = units.get(battle, context.request.target);

    return (
        target?.lifecycle === "PRESENT" &&
        target.vitality.hp > 0 &&
        target.vitality.damageReceptionRules.every((rule) => rule.allows(battle, context))
    );
}

function observers(request: DamageRequest): readonly Ref<Unit>[] {
    return request.source !== null && request.source.id !== request.target.id
        ? [request.target, request.source]
        : [request.target];
}

function complete(
    battle: BattleState,
    request: DamageRequest,
    calculated: CalculatedDamage | undefined,
    outcome: DamageOutcome,
): Result<DamageOutcome> {
    if (outcome.kind === "CANCELLED") {
        const target = units.get(battle, request.target);

        if (calculated !== undefined) {
            battle = appendEvents(battle, [
                {
                    type: "DAMAGE",
                    sourceUnitId: request.source?.id ?? null,
                    targetUnitId: request.target.id,
                    damageType: calculated.type,
                    amount: 0,
                    receivedAmount: outcome.received.amount,
                    hp: target?.vitality.hp ?? null,
                    tick: battle.tick,
                    cancellation: outcome.received.cancellation,
                },
            ]);
        }
    }

    for (const owner of observers(request)) {
        battle = dispatch(battle, owner, { request, calculated, outcome }, undefined, (entry) =>
            entry.stage === "completed" ? entry : undefined,
        ).state;
    }

    return { state: battle, value: outcome };
}
