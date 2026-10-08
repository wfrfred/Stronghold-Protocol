import { assertNonnegativeNumber } from "../../../../common/assert.js";
import type { QueryPurpose } from "../../targeting/query.js";
import { resolveAttackPower } from "../offense/query.js";
import { createDamageOperands, type DamageType } from "../vitality/damage/contract.js";
import { EffectDispatchScope } from "../effects/dispatch.js";
import type { ActionResources } from "./resources.js";
import { combatWorkView, getCombatUnit, type CombatWork } from "../../../battle/execution/work.js";
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
      };

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
                    ? ({ work, sourceUnitId }: Context): number => {
                          const source = getCombatUnit(work, sourceUnitId);

                          return source === undefined
                              ? definition.power
                              : resolveAttackPower(
                                    source.id,
                                    combatWorkView(work),
                                    resources.computations,
                                )!;
                      }
                    : (): number => definition.power;

            return ({ work, sourceUnitId, targetUnitId, tick }) => {
                return resources.settleDamage(
                    work,
                    {
                        sourceUnitId,
                        targetUnitId,
                        tick,
                        damageType: definition.damageType,
                        operands: createDamageOperands(
                            readPower({ work, sourceUnitId, targetUnitId, tick }),
                        ),
                    },
                    new EffectDispatchScope(),
                ).work;
            };
        }

        case "HEAL":
            return ({ work, sourceUnitId, targetUnitId, tick }) =>
                resources.settleHealing(
                    work,
                    {
                        sourceUnitId,
                        targetUnitId,
                        power: definition.power,
                        ignoreHealFree: definition.ignoreHealFree,
                    },
                    tick,
                    new EffectDispatchScope(),
                ).work;
    }
}
