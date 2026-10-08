import {
    createSkillDefinition,
    type SkillActivationMode,
    type SkillDefinition,
    type SkillSpRecovery,
} from "../../core/tactical/unit/capability/skill/capability.js";
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

function activation(value: unknown): SkillActivationMode {
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

function spRecovery(value: unknown): SkillSpRecovery {
    switch (value) {
        case "INCREASE_WITH_TIME":
        case 1:
            return "TIME";

        case "INCREASE_WHEN_ATTACK":
        case 2:
            return "ATTACK";

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

export function parseArknightsSkillLevel(value: unknown, level = 1): ArknightsSkillLevel {
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

    if (
        selected.durationType !== undefined &&
        selected.durationType !== "NONE" &&
        selected.durationType !== 0
    ) {
        throw new TypeError("unsupported skill duration mode");
    }

    const sp = object(selected.spData, "skill SP data");
    const recovery = spRecovery(sp.spType);
    const increment = number(sp.increment, "skill SP increment");
    const duration = number(selected.duration, "skill duration");

    if (increment < 0 || (recovery === "TIME" && increment === 0)) {
        throw new RangeError("skill SP increment must enable its recovery mode");
    }
    if ((recovery === "ATTACK" || recovery === "HIT") && increment !== 1) {
        throw new TypeError(
            "nonstandard attack or hit SP increments require dedicated skill content",
        );
    }
    if (duration < 0 && duration !== -1) {
        throw new RangeError("skill duration must be nonnegative or unlimited");
    }

    return Object.freeze({
        definition: createSkillDefinition({
            id: skill.skillId,
            activation: activation(selected.skillType),
            spRecovery: recovery,
            spCost: number(sp.spCost, "skill SP cost"),
            initialSp: number(sp.initSp, "skill initial SP"),
            maxCharges: number(sp.maxChargeTime, "skill maximum charges"),
            ...(recovery === "TIME"
                ? { spRecoveryIntervalTicks: TICKS_PER_SECOND / increment }
                : {}),
            durationTicks: duration === -1 ? null : secondsToTicks(duration, "skill duration"),
        }),
        level,
        blackboard: parseBlackboard(selected.blackboard, "skill blackboard"),
    });
}
