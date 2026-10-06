import { parseBlackboard, type ArknightsBlackboardEntry } from "./blackboard.js";
import type { ArknightsPredefinedInstance } from "./level.js";

export interface ArknightsResolvedSkill {
    readonly skillId: string;
    readonly prefabKey: string | null;
    readonly level: number;
    readonly blackboard: readonly ArknightsBlackboardEntry[];
}

function object(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }

    return value as Record<string, unknown>;
}

function identifier(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${name} must be nonempty`);
    }

    return value;
}

function characterSkill(
    instance: ArknightsPredefinedInstance,
    characterValue: unknown,
): Record<string, unknown> {
    const character = object(characterValue, "character record");

    if (
        !Array.isArray(character.skills) ||
        instance.skillIndex < 0 ||
        !Object.hasOwn(character.skills, instance.skillIndex)
    ) {
        throw new RangeError(
            `unknown skill index ${instance.skillIndex} for ${instance.inst.characterKey}`,
        );
    }

    return object(character.skills[instance.skillIndex], "character skill");
}

export function resolvePredefinedSkillId(
    instance: ArknightsPredefinedInstance,
    characterValue: unknown,
): string {
    return identifier(characterSkill(instance, characterValue).skillId, "character skill id");
}

export function resolvePredefinedSkillBlackboard(
    instance: ArknightsPredefinedInstance,
    characterValue: unknown,
    skillValue: unknown,
): ArknightsResolvedSkill {
    const selected = characterSkill(instance, characterValue);
    const skillId = identifier(selected.skillId, "character skill id");
    const skill = object(skillValue, "skill record");

    if (skill.skillId !== skillId) {
        throw new TypeError(`skill record does not match ${skillId}`);
    }
    if (!Array.isArray(skill.levels) || skill.levels.length === 0) {
        throw new TypeError(`${skillId} requires skill levels`);
    }

    const level = Math.min(Math.max(instance.mainSkillLvl, 1), skill.levels.length);
    const selectedLevel = object(skill.levels[level - 1], `skill level ${level}`);
    const useDefaultPrefab =
        selected.overridePrefabKey === null ||
        selected.overridePrefabKey === undefined ||
        selected.overridePrefabKey === "";
    const prefabId = useDefaultPrefab ? selectedLevel.prefabId : selected.overridePrefabKey;
    const prefabKey =
        prefabId === null || prefabId === "" ? null : identifier(prefabId, "skill prefab id");

    const blackboard = new Map<string, ArknightsBlackboardEntry>();

    for (const entry of parseBlackboard(selectedLevel.blackboard, `${skillId} blackboard`)) {
        const key = entry.key.toLowerCase();

        if (blackboard.has(key)) {
            throw new TypeError(`${skillId} has duplicate blackboard key ${entry.key}`);
        }

        blackboard.set(key, entry);
    }

    for (const entry of instance.overrideSkillBlackboard ?? []) {
        blackboard.set(entry.key.toLowerCase(), Object.freeze({ ...entry }));
    }

    return Object.freeze({
        skillId,
        prefabKey,
        level,
        blackboard: Object.freeze([...blackboard.values()]),
    });
}
