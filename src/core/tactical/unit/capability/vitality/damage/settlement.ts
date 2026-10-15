import { emptyCall, type CallContext } from "../../../../battle/execution/call.js";
import type { Parameters } from "../../defense/capability.js";
import { hasElemental } from "../../elemental/capability.js";
import { hasVitality } from "../capability.js";
import type { Id } from "../../../unit.js";
import { receptionCancellation } from "./reception.js";
import { isFatalDamageProtected } from "./fatal-protection.js";
import { resolveDefense } from "../../defense/query.js";
import { assertFiniteNumber, assertNonnegativeNumber } from "../../../../../common/assert.js";
import {
    type DamageType,
    type DamageOperands,
    type DamageReport,
    type DamageRequest,
    type PendingDamage,
    NORMAL_DAMAGE_RECEPTION,
} from "./contract.js";
import type { Context, Hook, FormulaStage, AmountStage } from "./hook.js";
import type { Hook as RegisteredHook } from "../../../hook/hook.js";
import { hookScope, type Result } from "../hook.js";
import { gainUnitSkillSp } from "../../../../battle/execution/skill-sp.js";
import { retireCombatUnit } from "../../../../battle/execution/unit-lifecycle.js";
import type { SkillExecutionResources } from "../../skill/execution.js";
import {
    battlefieldView,
    appendEvents,
    getUnit,
    updateUnit,
    type State as BattleState,
    type Result as Settlement,
} from "../../../../battle/state.js";

export function calculateDamage(
    power: number,
    damageType: DamageType,
    defense: Parameters,
    elementDamageResistance = 0,
): number {
    switch (damageType) {
        case "PHYSICAL":
            return Math.max(power * 0.05, power - defense.defense);

        case "ARTS":
            return Math.max(power * 0.05, power * (1 - defense.resistance / 100));

        case "TRUE":
            return power;

        case "ELEMENTAL":
            return Math.max(
                power * 0.05,
                power * Math.max(0, 1 - Math.max(0, elementDamageResistance) / 100),
            );
    }
}

export function resolveDamage(
    state: BattleState,
    request: DamageRequest,
    resources: SkillExecutionResources,
    call: CallContext = emptyCall,
): Settlement<DamageReport> {
    const policy = request.receptionPolicy ?? NORMAL_DAMAGE_RECEPTION;
    const target = getUnit(state, request.targetUnitId);
    const report: DamageReport = {
        request,
        formulaDamage: null,
        outputDamage: null,
        hpDamage: null,
        hpLoss: 0,
        resourceConsumptions: [],
        cancellation: null,
        deathOccurred: false,
        fatalProtection: false,
    };

    if (target === undefined || !hasVitality(target) || target.vitality.hp <= 0) {
        let reason = "TARGET_ABSENT";

        if (target !== undefined) {
            reason = hasVitality(target) ? "TARGET_DEAD" : "NO_VITALITY";
        }

        const result: DamageReport = {
            ...report,
            cancellation: { stage: "INPUT", reason },
        };
        state = notifyReactions(state, result, call);

        return { state, value: result };
    }

    let operands = request.operands;

    for (const [owner, stage] of [
        [request.sourceUnitId, "sourceFormula"],
        [request.targetUnitId, "targetFormula"],
    ] as const) {
        const applied = applyFormulaHooks(state, request, owner, stage, operands, call);
        state = applied.state;
        operands = applied.value;
    }

    const current = getUnit(state, request.targetUnitId);

    if (current === undefined || !hasVitality(current) || current.vitality.hp <= 0) {
        const result: DamageReport = {
            ...report,
            cancellation: { stage: "FORMULA", reason: "TARGET_UNAVAILABLE" },
        };
        state = notifyReactions(state, result, call);

        return { state, value: result };
    }

    const defense = resolveDefense(current.id, battlefieldView(state))!;
    const effectiveDefense = {
        defense:
            Math.max(0, defense.defense - operands.fixedPenetration) *
            Math.max(0, 1 - operands.proportionalPenetration),
        resistance:
            Math.max(0, defense.resistance - operands.fixedPenetration) *
            Math.max(0, 1 - operands.proportionalPenetration),
    };
    const formulaDamage = calculateDamage(
        formulaPower(operands),
        request.damageType,
        effectiveDefense,
        hasElemental(current) ? current.definition.elemental.damageResistance : 0,
    );

    assertFiniteNumber(formulaDamage, "formula damage");

    let pending: PendingDamage = { amount: formulaDamage, cancellation: null, consumptions: [] };

    if (!policy.skipModifierEvents) {
        const applied = applyAmountHooks(
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

    const outputDamage = pending.amount;

    assertFiniteNumber(outputDamage, "output damage");

    const receiver = getUnit(state, request.targetUnitId);

    if (receiver === undefined || !hasVitality(receiver) || receiver.vitality.hp <= 0) {
        pending = {
            ...pending,
            cancellation: pending.cancellation ?? {
                stage: "RECEPTION",
                reason: "TARGET_UNAVAILABLE",
            },
        };
    } else {
        const cancellation = receptionCancellation({
            source:
                request.sourceUnitId === null ? undefined : getUnit(state, request.sourceUnitId),
            target: receiver,
            battlefield: battlefieldView(state),
            request,
            policy,
        });

        if (cancellation !== null) {
            pending = {
                ...pending,
                cancellation: pending.cancellation ?? cancellation,
            };
        }

        if (pending.cancellation === null && request.ignoreForSp !== true) {
            state = gainUnitSkillSp(state, request.targetUnitId, "HIT");
        }

        const applied = applyAmountHooks(
            state,
            request,
            request.targetUnitId,
            policy.skipModifierEvents ? "skippedReception" : "reception",
            pending,
            call,
        );
        state = applied.state;
        pending = applied.value;
    }

    const hpDamage = pending.amount;

    assertNonnegativeNumber(hpDamage, "received damage");

    const finalTarget = getUnit(state, request.targetUnitId);

    if (
        pending.cancellation !== null ||
        finalTarget === undefined ||
        !hasVitality(finalTarget) ||
        finalTarget.vitality.hp <= 0
    ) {
        const cancellation = pending.cancellation ?? {
            stage: "RECEPTION" as const,
            reason: "TARGET_UNAVAILABLE",
        };

        if (finalTarget !== undefined && hasVitality(finalTarget)) {
            state = appendEvents(state, [
                {
                    type: "DAMAGE",
                    sourceUnitId: request.sourceUnitId,
                    targetUnitId: request.targetUnitId,
                    damageType: request.damageType,
                    amount: 0,
                    hp: finalTarget.vitality.hp,
                    tick: request.tick,
                },
            ]);
        }

        const result: DamageReport = {
            ...report,
            formulaDamage,
            outputDamage,
            resourceConsumptions: pending.consumptions,
            cancellation,
        };
        state = notifyReactions(state, result, call);

        return { state, value: result };
    }

    const candidateHp = Math.max(0, finalTarget.vitality.hp - hpDamage);
    const fatalProtection = isFatalDamageProtected({
        source: request.sourceUnitId === null ? undefined : getUnit(state, request.sourceUnitId),
        target: finalTarget,
        battlefield: battlefieldView(state),
        request,
        policy,
        hpDamage,
        candidateHp,
    });
    const hp = fatalProtection ? Math.min(1, finalTarget.vitality.hp) : candidateHp;
    const hpLoss = finalTarget.vitality.hp - hp;

    if (hpLoss !== 0) {
        const updated = {
            ...finalTarget,
            vitality: { ...finalTarget.vitality, hp },
        };

        state = updateUnit(state, updated);
    }

    state = appendEvents(state, [
        {
            type: "DAMAGE",
            sourceUnitId: request.sourceUnitId,
            targetUnitId: request.targetUnitId,
            damageType: request.damageType,
            amount: hpLoss,
            hp,
            tick: request.tick,
        },
    ]);

    const result: DamageReport = {
        ...report,
        formulaDamage,
        outputDamage,
        hpDamage,
        hpLoss,
        resourceConsumptions: pending.consumptions,
        deathOccurred: hp === 0,
        fatalProtection,
    };
    state = notifyReactions(state, result, call);

    const afterReactions = getUnit(state, request.targetUnitId);

    if (
        result.deathOccurred &&
        afterReactions !== undefined &&
        hasVitality(afterReactions) &&
        afterReactions.vitality.hp <= 0
    ) {
        state = retireCombatUnit(state, request.targetUnitId, resources, request.tick, call);
    }

    return { state, value: result };
}

function formulaPower(operands: DamageOperands): number {
    return Math.max(
        0,
        operands.power * operands.attackScale +
            (operands.attackScale > 0 ? operands.attackAddition : 0),
    );
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
    request: DamageRequest,
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
    const candidates = scope.candidates.damage
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
            !current.vitality.damageHooks.includes(entry)
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

function applyFormulaHooks(
    battle: BattleState,
    request: DamageRequest,
    owner: Id | null,
    stage: FormulaStage,
    operands: DamageOperands,
    call: CallContext,
): Settlement<DamageOperands> {
    return callHooks(battle, request, owner, operands, call, (entry) =>
        (entry.stage === "sourceFormula" || entry.stage === "targetFormula") &&
        entry.stage === stage
            ? entry
            : undefined,
    );
}

function applyAmountHooks(
    battle: BattleState,
    request: DamageRequest,
    owner: Id | null,
    stage: AmountStage,
    pending: PendingDamage,
    call: CallContext,
): Settlement<PendingDamage> {
    return callHooks(battle, request, owner, pending, call, (entry) =>
        (entry.stage === "output" ||
            entry.stage === "reception" ||
            entry.stage === "skippedReception") &&
        entry.stage === stage
            ? entry
            : undefined,
    );
}

function notifyReactions(state: BattleState, report: DamageReport, call: CallContext): BattleState {
    if (!(report.request.receptionPolicy ?? NORMAL_DAMAGE_RECEPTION).skipModifierEvents) {
        for (const owner of new Set([report.request.sourceUnitId, report.request.targetUnitId])) {
            state = callHooks(state, report.request, owner, report, call, (entry) =>
                entry.stage === "reaction" ? entry : undefined,
            ).state;
        }
    }

    return state;
}
