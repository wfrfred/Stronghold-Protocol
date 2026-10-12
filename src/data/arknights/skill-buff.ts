import { getUnit, updateUnit } from "../../core/tactical/battle/state.js";
import * as modifier from "../../core/tactical/unit/contribution/value.js";
import type { Definition } from "../../core/tactical/unit/effect/definition.js";
import { install } from "../../core/tactical/unit/effect/operations.js";
import {
    hasOffense,
    removeAttackContribution,
    setAttackContribution,
    type Offense,
} from "../../core/tactical/unit/capability/offense/capability.js";
import type { CompiledSkill } from "../../core/tactical/unit/capability/skill/compiled.js";
import { parseArknightsSkillLevel } from "./skill-definition.js";

export function compileArknightsAttackBuffSkill(value: unknown, level: number): CompiledSkill {
    const parsed = parseArknightsSkillLevel(value, level);

    if (!/^skcom_atk_up\[[123]\]$/.test(parsed.definition.id)) {
        throw new TypeError(`unsupported attack buff skill ${parsed.definition.id}`);
    }

    const entries = parsed.blackboard.filter((entry) => entry.key.toLowerCase() === "atk");

    if (entries.length !== 1 || typeof entries[0]!.value !== "number") {
        throw new TypeError("attack buff skill requires one numeric atk blackboard entry");
    }

    const attackIncrease = entries[0]!.value;
    const buff: Definition<{ readonly attackIncrease: number }, Offense> = {
        id: `skill/${parsed.definition.id}/${level}/attack`,
        initialize: () => ({ attackIncrease }),
        onEnable: (state, context) => {
            return updateUnit(
                state,
                setAttackContribution(context.unit, {
                    id: `@effect/${context.self.id}/attack`,
                    value: [modifier.create({ multiplier: context.self.data.attackIncrease })],
                }),
            );
        },
        onDisable: (state, context) => {
            return updateUnit(
                state,
                removeAttackContribution(context.unit, `@effect/${context.self.id}/attack`),
            );
        },
    };

    return {
        definition: parsed.definition,
        activate: (state, context) => {
            const unit = getUnit(state, context.unitId);

            if (unit === undefined || !hasOffense(unit)) {
                return {
                    state,
                    value: { type: "REJECTED", reason: "attack buff requires Offense capability" },
                };
            }

            const installed = install(
                state,
                unit,
                buff,
                {
                    source: context.unitId,
                    scopes: [
                        {
                            type: "SKILL",
                            unitId: context.unitId,
                            activationId: context.activationId,
                        },
                    ],
                },
                context.call,
            );

            return {
                state: installed.state,
                value:
                    installed.value === undefined
                        ? { type: "REJECTED", reason: "effect installation rejected" }
                        : { type: "ACTIVATED" },
            };
        },
    };
}
