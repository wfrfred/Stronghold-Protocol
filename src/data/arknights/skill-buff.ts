import { get as getUnit, ref as unitRef } from "../../core/tactical/unit/query.js";
import { updateUnit } from "../../core/tactical/battle/state.js";
import * as modifier from "../../core/tactical/unit/contribution/value.js";
import type { Definition } from "../../core/tactical/unit/effect/definition.js";
import { install } from "../../core/tactical/unit/effect/operations.js";
import {
    hasOffense,
    removeAttackContribution,
    setAttackContribution,
    type Offense,
} from "../../core/tactical/unit/capability/offense/capability.js";
import type { Definition as SkillDefinition } from "../../core/tactical/unit/capability/skill/capability.js";
import { ref as activationRef } from "../../core/tactical/unit/capability/skill/activation.js";
import { parseArknightsSkillLevel } from "./skill-definition.js";

export function compileArknightsAttackBuffSkill(value: unknown, level: number): SkillDefinition {
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
            return updateUnit(state, {
                ...context.unit,
                offense: setAttackContribution(context.unit.offense, {
                    id: `@effect/${context.self.id}/attack`,
                    value: [modifier.create({ multiplier: context.self.data.attackIncrease })],
                }),
            });
        },
        onDisable: (state, context) => {
            return updateUnit(state, {
                ...context.unit,
                offense: removeAttackContribution(
                    context.unit.offense,
                    `@effect/${context.self.id}/attack`,
                ),
            });
        },
    };

    return {
        ...parsed.definition,
        activation: {
            ...parsed.definition.activation!,
            accepts: (battle, self) => {
                const host = getUnit(battle, self.host);

                return host !== undefined && hasOffense(host);
            },
            onStart: (state, self) => {
                const unit = getUnit(state, self.host);

                if (unit === undefined || !hasOffense(unit)) {
                    return state;
                }

                const installed = install(state, unitRef(unit), buff, {
                    source: unit.id,
                    scopes: [
                        {
                            type: "SKILL",
                            ref: activationRef(self),
                        },
                    ],
                });

                return installed.state;
            },
        },
    };
}
