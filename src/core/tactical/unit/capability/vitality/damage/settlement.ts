import { hasDefenseDefinition, type DefenseDefinition } from "../../defense/capability.js";
import { hasVitality, type Vitality } from "../capability.js";
import type { Unit } from "../../../unit.js";
import { hasStatusFlag } from "../../status/capability.js";
import { resolveDefense } from "../../defense/query.js";
import type {
    DamageType,
    DamageOperands,
    DamageReport,
    DamageRequest,
    DamageResolution,
    PendingDamage,
} from "./contract.js";
import { retireCombatUnit } from "../../../../battle/execution/unit-lifecycle.js";
import type { DamageResourceServices } from "./resources.js";
import {
    combatWorkView,
    appendCombatEvents,
    getCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "../../../../battle/execution/work.js";

const NO_DEFENSE: DefenseDefinition = Object.freeze({ defense: 0, resistance: 0 });

export interface DamageResult<U extends Unit & Vitality> {
    readonly unit: U;
    readonly amount: number;
    readonly killed: boolean;
}

export function calculateDamage(
    power: number,
    damageType: DamageType,
    defense: DefenseDefinition,
): number {
    switch (damageType) {
        case "PHYSICAL":
            return Math.max(power * 0.05, power - defense.defense);

        case "ARTS":
            return Math.max(power * 0.05, power * (1 - defense.resistance / 100));

        case "TRUE":
            return power;
    }
}

export function damageUnit<U extends Unit & Vitality>(
    unit: U,
    power: number,
    damageType: DamageType,
): DamageResult<U> {
    const defense = hasDefenseDefinition(unit.definition) ? unit.definition.defense : NO_DEFENSE;
    const damage = hasStatusFlag(unit, "INVINCIBLE")
        ? 0
        : calculateDamage(power, damageType, defense);
    const candidateHp = Math.max(0, unit.vitality.hp - damage);
    const hp =
        candidateHp === 0 && unit.vitality.hp > 0 && hasStatusFlag(unit, "UNDEADABLE")
            ? Math.min(1, unit.vitality.hp)
            : candidateHp;
    const amount = unit.vitality.hp - hp;

    return {
        unit: amount === 0 ? unit : { ...unit, vitality: { ...unit.vitality, hp } },
        amount,
        killed: unit.vitality.hp > 0 && hp === 0,
    };
}

function formulaPower(operands: DamageOperands): number {
    return Math.max(
        0,
        operands.power * operands.attackScale +
            (operands.attackScale > 0 ? operands.attackAddition : 0),
    );
}

function confirmDamage(
    work: CombatWork,
    report: DamageReport,
    resources: DamageResourceServices,
): DamageResolution {
    report = Object.freeze(report);

    const reactions = resources.damage.reactionRules(work, [
        report.request.sourceUnitId,
        report.request.targetUnitId,
    ]);

    for (const reaction of reactions) {
        work = reaction.apply(work, report);
    }
    if (report.deathOccurred) {
        work = retireCombatUnit(work, report.request.targetUnitId, resources, report.request.tick);
    }

    return { work, report };
}

export function resolveDamage(
    work: CombatWork,
    request: DamageRequest,
    resources: DamageResourceServices,
): DamageResolution {
    const target = getCombatUnit(work, request.targetUnitId);
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

        return confirmDamage(
            work,
            {
                ...report,
                cancellation: {
                    stage: "INPUT",
                    reason,
                },
            },
            resources,
        );
    }

    let operands = request.operands;

    for (const [owner, stage] of [
        [request.sourceUnitId, "sourceFormula"],
        [request.targetUnitId, "targetFormula"],
    ] as const) {
        const rules = resources.damage.formulaRules(work, owner, stage);

        for (const rule of rules) {
            const result = rule.apply(work, request, operands);
            work = result.work;
            operands = result.value;
        }
    }

    const current = getCombatUnit(work, request.targetUnitId);

    if (current === undefined || !hasVitality(current) || current.vitality.hp <= 0) {
        return confirmDamage(
            work,
            { ...report, cancellation: { stage: "FORMULA", reason: "TARGET_UNAVAILABLE" } },
            resources,
        );
    }

    const defense = resolveDefense(current.id, combatWorkView(work), resources.defense)!;
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
    );
    let pending: PendingDamage = { amount: formulaDamage, cancellation: null, consumptions: [] };

    for (const rule of resources.damage.amountRules(work, request.sourceUnitId, "output")) {
        const result = rule.apply(work, request, pending);
        work = result.work;
        pending = result.value;

        if (pending.cancellation !== null) {
            return confirmDamage(
                work,
                {
                    ...report,
                    formulaDamage,
                    resourceConsumptions: pending.consumptions,
                    cancellation: pending.cancellation,
                },
                resources,
            );
        }
    }

    const outputDamage = pending.amount;
    const receiver = getCombatUnit(work, request.targetUnitId);

    if (
        receiver === undefined ||
        !hasVitality(receiver) ||
        receiver.vitality.hp <= 0 ||
        hasStatusFlag(receiver, "INVINCIBLE")
    ) {
        pending = {
            ...pending,
            cancellation: {
                stage: "RECEPTION",
                reason:
                    receiver !== undefined && hasStatusFlag(receiver, "INVINCIBLE")
                        ? "INVINCIBLE"
                        : "TARGET_UNAVAILABLE",
            },
        };
    } else {
        for (const rule of resources.damage.amountRules(work, request.targetUnitId, "reception")) {
            const result = rule.apply(work, request, pending);
            work = result.work;
            pending = result.value;

            if (pending.cancellation !== null) {
                break;
            }
        }
    }

    const finalTarget = getCombatUnit(work, request.targetUnitId);

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
            work = appendCombatEvents(work, [
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

        return confirmDamage(
            work,
            {
                ...report,
                formulaDamage,
                outputDamage,
                resourceConsumptions: pending.consumptions,
                cancellation,
            },
            resources,
        );
    }

    const candidateHp = Math.max(0, finalTarget.vitality.hp - pending.amount);
    const fatalProtection = candidateHp === 0 && hasStatusFlag(finalTarget, "UNDEADABLE");
    const hp = fatalProtection ? Math.min(1, finalTarget.vitality.hp) : candidateHp;
    const hpLoss = finalTarget.vitality.hp - hp;

    if (hpLoss !== 0) {
        const updated = {
            ...finalTarget,
            vitality: { ...finalTarget.vitality, hp },
        };

        work = updateCombatUnit(work, updated);
    }

    work = appendCombatEvents(work, [
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

    return confirmDamage(
        work,
        {
            ...report,
            formulaDamage,
            outputDamage,
            hpDamage: pending.amount,
            hpLoss,
            resourceConsumptions: pending.consumptions,
            deathOccurred: hp === 0,
            fatalProtection,
        },
        resources,
    );
}
