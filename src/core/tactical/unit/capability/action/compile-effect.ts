import { resolveAttackPower } from "../offense/query.js";
import { createDamageOperands } from "../vitality/damage/contract.js";
import { resolveDamage } from "../vitality/damage/settlement.js";
import type { EffectDefinition } from "./effect.js";
import { resolveHealing } from "../vitality/healing/settlement.js";
import type { ActionResources } from "./resources.js";
import { combatWorkView, getCombatUnit, type CombatWork } from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";

export interface EffectExecutionContext {
    readonly work: CombatWork;
    readonly sourceUnitId: UnitId;
    readonly targetUnitId: UnitId;
    readonly tick: number;
}

export type CompiledEffect = (context: EffectExecutionContext) => CombatWork;

export function compileEffect(
    definition: EffectDefinition,
    resources: ActionResources,
): CompiledEffect {
    switch (definition.type) {
        case "DAMAGE": {
            const readPower =
                definition.powerSource === "SOURCE_ATTACK"
                    ? ({ work, sourceUnitId }: EffectExecutionContext): number => {
                          const source = getCombatUnit(work, sourceUnitId);

                          return source === undefined
                              ? definition.power
                              : resolveAttackPower(
                                    source.id,
                                    combatWorkView(work),
                                    resources.offense,
                                )!;
                      }
                    : (): number => definition.power;

            return ({ work, sourceUnitId, targetUnitId, tick }) => {
                return resolveDamage(
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
                    resources,
                ).work;
            };
        }

        case "HEAL":
            return ({ work, sourceUnitId, targetUnitId, tick }) =>
                resolveHealing(
                    work,
                    {
                        sourceUnitId,
                        targetUnitId,
                        power: definition.power,
                        ignoreHealFree: definition.ignoreHealFree,
                    },
                    resources,
                    tick,
                ).work;
    }
}
