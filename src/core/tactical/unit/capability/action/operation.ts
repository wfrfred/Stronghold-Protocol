import { assertNonnegativeNumber } from "../../../../common/assert.js";
import type { ElementType } from "../elemental/capability.js";
import type { QueryPurpose } from "../../targeting/query.js";
import { resolveAttackPower } from "../offense/query.js";
import { createDamageOperands, type DamageType } from "../vitality/damage/contract.js";
import { EffectDispatchScope } from "../effects/dispatch.js";
import type { ActionResources } from "./resources.js";
import { combatWorkView, type CombatWork } from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";

export type Definition =
    | {
          readonly type: "DAMAGE";
          readonly power: number;
          readonly damageType: DamageType;
          readonly powerSource?: "SOURCE_ATTACK";
      }
    | {
          readonly type: "HEAL";
          readonly power: number;
          readonly ignoreHealFree: boolean;
      }
    | { readonly type: "ELEMENT_DAMAGE"; readonly elementType: ElementType; readonly power: number }
    | { readonly type: "ELEMENT_HEAL"; readonly power: number };

export function create(definition: Definition): Definition {
    assertNonnegativeNumber(definition.power, "operation power");

    return Object.freeze({ ...definition });
}

export function purposes(definition: Definition): readonly QueryPurpose[] {
    switch (definition.type) {
        case "DAMAGE":
            return ["DAMAGE"];

        case "HEAL":
            return ["HEAL"];

        case "ELEMENT_DAMAGE":
            return ["ELEMENT_DAMAGE"];

        case "ELEMENT_HEAL":
            return ["ELEMENT_HEAL"];
    }
}

export interface Context {
    readonly work: CombatWork;
    readonly sourceUnitId: UnitId;
    readonly targetUnitId: UnitId;
    readonly tick: number;
}

export type Program = (context: Context) => CombatWork;

export function compile(definition: Definition, resources: ActionResources): Program {
    switch (definition.type) {
        case "DAMAGE": {
            const readPower =
                definition.powerSource === "SOURCE_ATTACK"
                    ? ({ work, sourceUnitId }: Context): number | undefined =>
                          resolveAttackPower(
                              sourceUnitId,
                              combatWorkView(work),
                              resources.computations,
                          )
                    : (): number => definition.power;

            return (context) => {
                const { work, sourceUnitId, targetUnitId, tick } = context;
                const power = readPower(context);

                if (power === undefined) {
                    return work;
                }

                return resources.settleDamage(
                    work,
                    {
                        sourceUnitId,
                        targetUnitId,
                        tick,
                        damageType: definition.damageType,
                        operands: createDamageOperands(power),
                    },
                    new EffectDispatchScope(),
                ).work;
            };
        }

        case "ELEMENT_DAMAGE":
            return ({ work, sourceUnitId, targetUnitId, tick }) =>
                resources.settleElementDamage(work, {
                    sourceUnitId,
                    targetUnitId,
                    tick,
                    type: definition.elementType,
                    power: definition.power,
                }).work;

        case "ELEMENT_HEAL":
            return ({ work, sourceUnitId, targetUnitId, tick }) =>
                resources.settleElementHeal(work, {
                    sourceUnitId,
                    targetUnitId,
                    tick,
                    power: definition.power,
                }).work;

        case "HEAL":
            return ({ work, sourceUnitId, targetUnitId, tick }) =>
                resources.settleHealing(
                    work,
                    {
                        sourceUnitId,
                        targetUnitId,
                        power: definition.power,
                        ignoreHealFree: definition.ignoreHealFree,
                        tick,
                    },
                    new EffectDispatchScope(),
                ).work;
    }
}
