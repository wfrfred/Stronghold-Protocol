import { createEnemyDefinition } from "../../core/tactical/unit/enemy.js";
import type { EnemyDefinition } from "../../core/tactical/unit/enemy.js";
import { perSecondToPerTick } from "./tick.js";

interface EnemyMovementValues {
    readonly maxHp: number | undefined;
    readonly moveSpeed: number | undefined;
}

function record(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }
    return value as Record<string, unknown>;
}

function enemyLevel(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("enemy level must be a nonnegative safe integer");
    }
    return value;
}

function attribute(value: unknown, name: "maxHp" | "moveSpeed"): number | undefined {
    if (value === undefined) return undefined;
    const source = record(value, `enemy ${name}`);
    if (typeof source.m_defined !== "boolean") {
        throw new TypeError(`enemy ${name}.m_defined must be boolean`);
    }
    if (!source.m_defined) return undefined;
    const number = source.m_value;
    if (typeof number !== "number" || !Number.isFinite(number)
        || (name === "maxHp" ? number <= 0 : number < 0)) {
        throw new RangeError(`defined enemy ${name} must be finite and ${name === "maxHp" ? "positive" : "non-negative"}`);
    }
    return number;
}

export function parseEnemyMovementDefinition(value: unknown, level: number): EnemyDefinition {
    const selectedLevel = enemyLevel(level);
    const source = record(value, "enemy database entry");
    if (typeof source.Key !== "string" || source.Key.length === 0) {
        throw new TypeError("enemy database Key must be nonempty");
    }
    if (!Array.isArray(source.Value)) {
        throw new TypeError("enemy database Value must be an array");
    }
    const levels = new Map<number, EnemyMovementValues>();
    for (let index = 0; index < source.Value.length; index++) {
        if (!Object.hasOwn(source.Value, index) || source.Value[index] === undefined) {
            throw new TypeError("enemy database Value must be dense");
        }
        const entry = record(source.Value[index], "enemy level entry");
        const entryLevel = enemyLevel(entry.level);
        if (levels.has(entryLevel)) {
            throw new RangeError(`duplicate enemy level ${entryLevel}`);
        }
        const data = record(entry.enemyData, "enemy level data");
        const attributes = record(data.attributes, "enemy attributes");
        levels.set(entryLevel, {
            maxHp: attribute(attributes.maxHp, "maxHp"),
            moveSpeed: attribute(attributes.moveSpeed, "moveSpeed"),
        });
    }
    const base = levels.get(0);
    if (base === undefined) throw new RangeError("enemy database requires level 0");
    const selected = levels.get(selectedLevel);
    if (selected === undefined) throw new RangeError(`unknown enemy level ${selectedLevel}`);
    const maxHp = selected.maxHp ?? base.maxHp;
    const moveSpeed = selected.moveSpeed ?? base.moveSpeed;
    if (maxHp === undefined) throw new TypeError("enemy maxHp requires a defined value");
    if (moveSpeed === undefined) throw new TypeError("enemy moveSpeed requires a defined value");
    return createEnemyDefinition({
        id: source.Key,
        vitality: { maxHp },
        locomotion: { moveSpeedPerTick: perSecondToPerTick(moveSpeed) },
    });
}
