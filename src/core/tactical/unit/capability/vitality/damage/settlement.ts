import { hasDefenseDefinition, type DefenseDefinition } from "../../defense/capability.js";
import { hasElemental } from "../../elemental/capability.js";
import { hasVitality, type Vitality } from "../capability.js";
import { widenUnit, type StableUnit, type Unit, type UnitId } from "../../../unit.js";
import { hasStatusFlag } from "../../status/capability.js";
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
import type { Result } from "../hook.js";
import { resolveHealing } from "../healing/settlement.js";
import { gainUnitSkillSp } from "../../../../battle/execution/skill-sp.js";
import {
    battlefieldView,
    appendEvents,
    getUnit,
    updateUnit,
    type BattleState,
} from "../../../../battle/execution/context.js";

export interface Resources {
    readonly retireUnit: (battle: BattleState, unitId: UnitId, tick: number) => void;
}

const NO_DEFENSE: DefenseDefinition = Object.freeze({ defense: 0, resistance: 0 });

export interface DamageResult<U extends Unit & Vitality> {
    readonly unit: StableUnit<U>;
    readonly amount: number;
    readonly killed: boolean;
}

export function calculateDamage(
    power: number,
    damageType: DamageType,
    defense: DefenseDefinition,
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

export function damageUnit<U extends Unit & Vitality>(
    unit: U | StableUnit<U>,
    power: number,
    damageType: DamageType,
): DamageResult<U> {
    const defense = hasDefenseDefinition(unit.definition) ? unit.definition.defense : NO_DEFENSE;
    const formulaDamage = calculateDamage(
        power,
        damageType,
        defense,
        hasElemental(unit) ? unit.definition.elemental.damageResistance : 0,
    );

    assertNonnegativeNumber(formulaDamage, "damage amount");

    const damage = hasStatusFlag(unit, "INVINCIBLE") ? 0 : formulaDamage;
    const candidateHp = Math.max(0, unit.vitality.hp - damage);
    const hp =
        candidateHp === 0 && unit.vitality.hp > 0 && hasStatusFlag(unit, "UNDEADABLE")
            ? Math.min(1, unit.vitality.hp)
            : candidateHp;
    const amount = unit.vitality.hp - hp;

    return {
        unit: widenUnit<U>(amount === 0 ? unit : { ...unit, vitality: { ...unit.vitality, hp } }),
        amount,
        killed: unit.vitality.hp > 0 && hp === 0,
    };
}

export function resolveDamage(
    state: BattleState,
    request: DamageRequest,
    resources: Resources,
): DamageReport {
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
        notifyReactions(state, result, resources);

        return result;
    }

    let operands = request.operands;

    for (const [owner, stage] of [
        [request.sourceUnitId, "sourceFormula"],
        [request.targetUnitId, "targetFormula"],
    ] as const) {
        operands = applyFormulaHooks(state, request, owner, stage, operands, resources);
    }

    const current = getUnit(state, request.targetUnitId);

    if (current === undefined || !hasVitality(current) || current.vitality.hp <= 0) {
        const result: DamageReport = {
            ...report,
            cancellation: { stage: "FORMULA", reason: "TARGET_UNAVAILABLE" },
        };
        notifyReactions(state, result, resources);

        return result;
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
        pending = applyAmountHooks(
            state,
            request,
            request.sourceUnitId,
            "output",
            pending,
            resources,
        );
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
        if (policy.considerInvincibility && hasStatusFlag(receiver, "INVINCIBLE")) {
            pending = {
                ...pending,
                cancellation: pending.cancellation ?? {
                    stage: "RECEPTION",
                    reason: "INVINCIBLE",
                },
            };
        }

        if (pending.cancellation === null && request.ignoreForSp !== true) {
            gainUnitSkillSp(state, request.targetUnitId, "HIT");
        }

        pending = applyAmountHooks(
            state,
            request,
            request.targetUnitId,
            policy.skipModifierEvents ? "skippedReception" : "reception",
            pending,
            resources,
        );
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
            appendEvents(state, [
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
        notifyReactions(state, result, resources);

        return result;
    }

    const candidateHp = Math.max(0, finalTarget.vitality.hp - hpDamage);
    const fatalProtection = candidateHp === 0 && hasStatusFlag(finalTarget, "UNDEADABLE");
    const hp = fatalProtection ? Math.min(1, finalTarget.vitality.hp) : candidateHp;
    const hpLoss = finalTarget.vitality.hp - hp;

    if (hpLoss !== 0) {
        const updated = {
            ...finalTarget,
            vitality: { ...finalTarget.vitality, hp },
        };

        updateUnit(state, updated);
    }

    appendEvents(state, [
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
    notifyReactions(state, result, resources);

    if (result.deathOccurred) {
        resources.retireUnit(state, request.targetUnitId, request.tick);
    }

    return result;
}

function formulaPower(operands: DamageOperands): number {
    return Math.max(
        0,
        operands.power * operands.attackScale +
            (operands.attackScale > 0 ? operands.attackAddition : 0),
    );
}

function notifyReactions(state: BattleState, report: DamageReport, resources: Resources): void {
    if (!(report.request.receptionPolicy ?? NORMAL_DAMAGE_RECEPTION).skipModifierEvents) {
        for (const owner of new Set([report.request.sourceUnitId, report.request.targetUnitId])) {
            callHooks(state, report.request, owner, report, resources, (entry) =>
                entry.stage === "reaction" ? entry : undefined,
            );
        }
    }
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
    request: DamageRequest,
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
        const candidates = snapshot.damage
            .flatMap((entry) => {
                const hook = select(entry);

                return hook === undefined ? [] : [{ entry, hook }];
            })
            .sort((left, right) => right.hook.priority - left.hook.priority);

        const context: Context = {
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
                !current.vitality.damageHooks.includes(entry) ||
                !hook.enabled(context)
            ) {
                continue;
            }

            const result = hook.invoke(context, value);

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

function applyFormulaHooks(
    battle: BattleState,
    request: DamageRequest,
    owner: UnitId | null,
    stage: FormulaStage,
    operands: DamageOperands,
    resources: Resources,
): DamageOperands {
    return callHooks(battle, request, owner, operands, resources, (entry) =>
        (entry.stage === "sourceFormula" || entry.stage === "targetFormula") &&
        entry.stage === stage
            ? entry
            : undefined,
    );
}

function applyAmountHooks(
    battle: BattleState,
    request: DamageRequest,
    owner: UnitId | null,
    stage: AmountStage,
    pending: PendingDamage,
    resources: Resources,
): PendingDamage {
    return callHooks(battle, request, owner, pending, resources, (entry) =>
        (entry.stage === "output" ||
            entry.stage === "reception" ||
            entry.stage === "skippedReception") &&
        entry.stage === stage
            ? entry
            : undefined,
    );
}
