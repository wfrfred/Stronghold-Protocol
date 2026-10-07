import { resolveAttackPower } from "./attributes.js";
import { createDamageOperands } from "./contract.js";
import { resolveDamage } from "./damage.js";
import type { EffectDefinition } from "./effect.js";
import { resolveHealing } from "./healing.js";
import type { CombatResources } from "./resources.js";
import { getCombatUnit, type CombatWork } from "./work.js";
import type { UnitId } from "../unit/unit.js";

export interface EffectExecutionContext {
    readonly work: CombatWork;
    readonly sourceUnitId: UnitId;
    readonly targetUnitId: UnitId;
    readonly tick: number;
}

export type CompiledEffect = (context: EffectExecutionContext) => CombatWork;

export function compileEffect(
    definition: EffectDefinition,
    resources: CombatResources,
): CompiledEffect {
    switch (definition.type) {
        case "DAMAGE": {
            const readPower =
                definition.powerSource === "SOURCE_ATTACK"
                    ? ({ work, sourceUnitId }: EffectExecutionContext): number => {
                          const source = getCombatUnit(work, sourceUnitId);

                          return source === undefined
                              ? definition.power
                              : resolveAttackPower(source, work, resources);
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
