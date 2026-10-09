import type { CombatResources } from "../../core/tactical/battle/resources.js";
import * as modifier from "../../core/tactical/modifier/value.js";
import { createEffectProgram } from "../../core/tactical/unit/capability/effects/program.js";
import { attack } from "../../core/tactical/unit/capability/offense/contributions.js";
import type { CompiledSkill } from "../../core/tactical/unit/capability/skill/program.js";
import { parseArknightsSkillLevel } from "./skill-definition.js";

export function compileArknightsAttackBuffSkill(
    value: unknown,
    level: number,
    resources: Pick<CombatResources, "registerEffect">,
): CompiledSkill {
    const parsed = parseArknightsSkillLevel(value, level);

    if (!/^skcom_atk_up\[[123]\]$/.test(parsed.definition.id)) {
        throw new TypeError(`unsupported attack buff skill ${parsed.definition.id}`);
    }

    const entries = parsed.blackboard.filter((entry) => entry.key.toLowerCase() === "atk");

    if (entries.length !== 1 || typeof entries[0]!.value !== "number") {
        throw new TypeError("attack buff skill requires one numeric atk blackboard entry");
    }

    const attackIncrease = entries[0]!.value;
    const buff = resources.registerEffect(
        createEffectProgram({
            id: `skill/${parsed.definition.id}/${level}/attack`,
            initialize: () => ({ attackIncrease }),
            ownState: (state) => ({ ...state }),
        }),
        {
            contributions: [
                attack((instance) => [
                    modifier.create({ multiplier: instance.state.attackIncrease }),
                ]),
            ],
        },
    );

    return Object.freeze({
        definition: parsed.definition,
        activate: (context) => {
            const installed = context.effects.install(context.unitId, buff.ref, {
                source: context.unitId,
                scopes: [
                    {
                        type: "SKILL",
                        unitId: context.unitId,
                        activationId: context.activationId,
                    },
                ],
            });

            return installed.type === "REJECTED"
                ? { type: "REJECTED", reason: installed.reason }
                : { type: "ACTIVATED" };
        },
    } satisfies CompiledSkill);
}
