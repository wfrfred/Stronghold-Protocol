import { hasDefenseDefinition, type DefenseDefinition } from "../../defense/capability.js";
import { hasElemental } from "../../elemental/capability.js";
import { hasVitality, type Vitality } from "../capability.js";
import { widenUnit, type StableUnit, type Unit } from "../../../unit.js";
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
import { EffectDispatchScope } from "../../effects/dispatch.js";
import {
    dispatchDamageFormula,
    dispatchDamageAmount,
    dispatchDamageReactions,
} from "./dispatch.js";
import { retireCombatUnit } from "../../../../battle/execution/unit-lifecycle.js";
import type { DamageResourceServices } from "./resources.js";
import { gainUnitSkillSp } from "../../../../battle/execution/skill-sp.js";
import {
    battlefieldView,
    appendEvents,
    getUnit,
    updateUnit,
    type BattleState,
} from "../../../../battle/execution/context.js";

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

function formulaPower(operands: DamageOperands): number {
    return Math.max(
        0,
        operands.power * operands.attackScale +
            (operands.attackScale > 0 ? operands.attackAddition : 0),
    );
}

function confirmDamage(
    work: BattleState,
    report: DamageReport,
    resources: DamageResourceServices,
    dispatch: EffectDispatchScope,
): DamageReport {
    report = Object.freeze(report);

    if (!(report.request.receptionPolicy ?? NORMAL_DAMAGE_RECEPTION).skipModifierEvents) {
        dispatchDamageReactions(work, report, resources, dispatch);
    }
    if (report.deathOccurred) {
        retireCombatUnit(
            work,
            report.request.targetUnitId,
            resources,
            report.request.tick,
            dispatch,
        );
    }

    return report;
}

export function resolveDamage(
    work: BattleState,
    request: DamageRequest,
    resources: DamageResourceServices,
    dispatch = new EffectDispatchScope(),
): DamageReport {
    const policy = request.receptionPolicy ?? NORMAL_DAMAGE_RECEPTION;
    const target = getUnit(work, request.targetUnitId);
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
            dispatch,
        );
    }

    let operands = request.operands;

    for (const [owner, stage] of [
        [request.sourceUnitId, "sourceFormula"],
        [request.targetUnitId, "targetFormula"],
    ] as const) {
        operands = dispatchDamageFormula(
            work,
            request,
            owner,
            stage,
            operands,
            resources,
            dispatch,
        );
    }

    const current = getUnit(work, request.targetUnitId);

    if (current === undefined || !hasVitality(current) || current.vitality.hp <= 0) {
        return confirmDamage(
            work,
            { ...report, cancellation: { stage: "FORMULA", reason: "TARGET_UNAVAILABLE" } },
            resources,
            dispatch,
        );
    }

    const defense = resolveDefense(current.id, battlefieldView(work), resources.computations)!;
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
        pending = dispatchDamageAmount(
            work,
            request,
            request.sourceUnitId,
            "output",
            pending,
            resources,
            dispatch,
        );
    }

    const outputDamage = pending.amount;

    assertFiniteNumber(outputDamage, "output damage");

    const receiver = getUnit(work, request.targetUnitId);

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
            gainUnitSkillSp(work, request.targetUnitId, "HIT");
        }

        pending = dispatchDamageAmount(
            work,
            request,
            request.targetUnitId,
            policy.skipModifierEvents ? "skippedReception" : "reception",
            pending,
            resources,
            dispatch,
        );
    }

    const hpDamage = pending.amount;

    assertNonnegativeNumber(hpDamage, "received damage");

    const finalTarget = getUnit(work, request.targetUnitId);

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
            appendEvents(work, [
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
            dispatch,
        );
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

        updateUnit(work, updated);
    }

    appendEvents(work, [
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
            hpDamage,
            hpLoss,
            resourceConsumptions: pending.consumptions,
            deathOccurred: hp === 0,
            fatalProtection,
        },
        resources,
        dispatch,
    );
}
