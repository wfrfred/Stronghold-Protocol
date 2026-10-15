import {
    createDefinition as createSkillDefinition,
    type Definition as SkillDefinition,
} from "../../core/tactical/unit/capability/skill/capability.js";
import type { Recovery } from "../../core/tactical/unit/capability/skill/sp.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";
import { parseBlackboard, type ArknightsBlackboardEntry } from "./blackboard.js";
import { secondsToTicks } from "./tick.js";

export interface ArknightsSkillLevel {
    readonly definition: SkillDefinition;
    readonly level: number;
    readonly blackboard: readonly ArknightsBlackboardEntry[];
}

function object(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }

    return value as Record<string, unknown>;
}

function number(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${name} must be a finite number`);
    }

    return value;
}

function activation(value: unknown): NonNullable<SkillDefinition["activation"]>["trigger"] {
    switch (value) {
        case "PASSIVE":
        case 0:
            return "PASSIVE";

        case "AUTO":
        case 1:
            return "AUTO";

        case "MANUAL":
        case 2:
            return "MANUAL";

        default:
            throw new TypeError(`unsupported skill activation ${String(value)}`);
    }
}

function spRecovery(value: unknown): Recovery["type"] {
    switch (value) {
        case "INCREASE_WITH_TIME":
        case 1:
            return "TIME";

        case "INCREASE_WHEN_ATTACK":
        case 2:
            return "ACTION";

        case "INCREASE_WHEN_TAKEN_DAMAGE":
        case 4:
            return "HIT";

        case "NONE":
        case 8:
            return "NONE";

        default:
            throw new TypeError(`unsupported skill SP recovery ${String(value)}`);
    }
}

export function parseArknightsSkillLevel(
    value: unknown,
    level = 1,
    ammo?: number,
): ArknightsSkillLevel {
    const skill = object(value, "skill record");

    if (typeof skill.skillId !== "string" || skill.skillId.length === 0) {
        throw new TypeError("skill record requires an identity");
    }
    if (
        !Number.isSafeInteger(level) ||
        level <= 0 ||
        !Array.isArray(skill.levels) ||
        !Object.hasOwn(skill.levels, level - 1)
    ) {
        throw new RangeError(`unknown skill level ${level} for ${skill.skillId}`);
    }

    const selected = object(skill.levels[level - 1], "skill level");
    const ammunitionMode = selected.durationType === "AMMO" || selected.durationType === 1;

    if (
        selected.durationType !== undefined &&
        selected.durationType !== "NONE" &&
        selected.durationType !== 0 &&
        !ammunitionMode
    ) {
        throw new TypeError("unsupported skill duration mode");
    }
    if (ammunitionMode && ammo === undefined) {
        throw new TypeError("AMMO skill requires an explicit ammunition count from its content");
    }
    if (!ammunitionMode && ammo !== undefined) {
        throw new TypeError("ammunition count requires AMMO skill data");
    }

    const sp = object(selected.spData, "skill SP data");
    const recovery = spRecovery(sp.spType);
    const increment = number(sp.increment, "skill SP increment");
    const duration = number(selected.duration, "skill duration");

    if (increment < 0 || (recovery === "TIME" && increment === 0)) {
        throw new RangeError("skill SP increment must enable its recovery mode");
    }
    if (duration < 0 && duration !== -1) {
        throw new RangeError("skill duration must be nonnegative or unlimited");
    }

    let recoveryDefinition: Recovery;

    if (recovery === "TIME") {
        recoveryDefinition = { type: "TIME", intervalTicks: TICKS_PER_SECOND / increment };
    } else if (recovery === "NONE") {
        recoveryDefinition = { type: "NONE" };
    } else {
        recoveryDefinition = { type: recovery, amount: increment };
    }

    let sustain: NonNullable<SkillDefinition["activation"]>["sustain"];

    if (ammo !== undefined) {
        sustain = { type: "AMMO", amount: ammo };
    } else if (duration === -1) {
        sustain = { type: "INFINITE" };
    } else {
        sustain = { type: "TIME", durationTicks: secondsToTicks(duration, "skill duration") };
    }

    return Object.freeze({
        definition: createSkillDefinition({
            id: skill.skillId,
            initialize: () => ({}),
            sp: {
                initial: number(sp.initSp, "skill initial SP"),
                capacity:
                    number(sp.spCost, "skill SP cost") *
                    number(sp.maxChargeTime, "skill maximum charges"),
                requirement: number(sp.spCost, "skill SP cost"),
                recovery: recoveryDefinition,
            },
            activation: {
                trigger: activation(selected.skillType),
                initialize: () => ({}),
                sustain,
            },
        }),
        level,
        blackboard: parseBlackboard(selected.blackboard, "skill blackboard"),
    });
}
