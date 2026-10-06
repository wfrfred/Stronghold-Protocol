import { createEnemyDefinition } from "../../core/tactical/unit/enemy.js";
import type { EnemyDefinition } from "../../core/tactical/unit/enemy.js";
import type { EnemyMovementPrefab } from "./prefab.js";
import { perSecondToPerTick } from "./tick.js";

interface EnemyMovementValues {
    readonly maxHp: number | undefined;
    readonly moveSpeed: number | undefined;
    readonly prefabKey: string | undefined;
    readonly notCountInTotal: boolean | undefined;
}

export interface ArknightsEnemyMovementContent {
    readonly definition: EnemyDefinition;
    readonly alwaysCheckCurrentPoint: boolean;
    readonly notCountInTotal: boolean;
    readonly delayToBornTicks: number;
    readonly onlyDelayToBornOnTileStart: boolean;
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

function defined(value: unknown, name: string): unknown {
    if (value === undefined) return undefined;
    const source = record(value, `enemy ${name}`);
    if (typeof source.m_defined !== "boolean") {
        throw new TypeError(`enemy ${name}.m_defined must be boolean`);
    }
    if (!source.m_defined) return undefined;
    if (!Object.hasOwn(source, "m_value") || source.m_value === undefined) {
        throw new TypeError(`defined enemy ${name} requires m_value`);
    }
    return source.m_value;
}

function attribute(value: unknown, name: "maxHp" | "moveSpeed"): number | undefined {
    const number = defined(value, name);
    if (number === undefined) return undefined;
    if (typeof number !== "number" || !Number.isFinite(number)
        || (name === "maxHp" ? number <= 0 : number < 0)) {
        throw new RangeError(`defined enemy ${name} must be finite and ${name === "maxHp" ? "positive" : "non-negative"}`);
    }
    return number;
}

function movementValues(data: Record<string, unknown>): EnemyMovementValues {
    const attributes = record(data.attributes, "enemy attributes");
    const prefabKey = defined(data.prefabKey, "prefabKey");
    if (prefabKey !== undefined && (typeof prefabKey !== "string" || prefabKey.length === 0)) {
        throw new TypeError("defined enemy prefabKey must be nonempty");
    }
    const notCountInTotal = defined(data.notCountInTotal, "notCountInTotal");
    if (notCountInTotal !== undefined && typeof notCountInTotal !== "boolean") {
        throw new TypeError("defined enemy notCountInTotal must be boolean");
    }
    return {
        maxHp: attribute(attributes.maxHp, "maxHp"),
        moveSpeed: attribute(attributes.moveSpeed, "moveSpeed"),
        prefabKey,
        notCountInTotal,
    };
}

function overwrite(value: unknown): EnemyMovementValues {
    if (value === null || value === undefined) return { maxHp: undefined, moveSpeed: undefined, prefabKey: undefined, notCountInTotal: undefined };
    const source = record(value, "enemy overwrittenData");
    const attributes = record(source.attributes, "enemy overwritten attributes");
    for (const [name, value] of Object.entries(attributes)) {
        if (name !== "maxHp" && name !== "moveSpeed" && defined(value, `overwritten attributes.${name}`) !== undefined) {
            throw new TypeError(`unsupported overwritten enemy attribute ${name}`);
        }
    }
    for (const [name, value] of Object.entries(source)) {
        if (name === "attributes" || name === "prefabKey" || name === "notCountInTotal") continue;
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) {
            if (value.length !== 0) throw new TypeError(`unsupported overwritten enemy ${name}`);
        } else if (defined(value, `overwritten ${name}`) !== undefined) {
            throw new TypeError(`unsupported overwritten enemy ${name}`);
        }
    }
    return movementValues(source);
}

function resolvedValues(value: unknown, level: number, overwrittenData?: unknown): {
    readonly id: string;
    readonly maxHp: number;
    readonly moveSpeed: number;
    readonly prefabKey: string;
    readonly notCountInTotal: boolean;
} {
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
        levels.set(entryLevel, movementValues(data));
    }
    const base = levels.get(0);
    if (base === undefined) throw new RangeError("enemy database requires level 0");
    const selected = levels.get(selectedLevel);
    if (selected === undefined) throw new RangeError(`unknown enemy level ${selectedLevel}`);
    const overridden = overwrite(overwrittenData);
    const maxHp = overridden.maxHp ?? selected.maxHp ?? base.maxHp;
    const moveSpeed = overridden.moveSpeed ?? selected.moveSpeed ?? base.moveSpeed;
    const prefabKey = overridden.prefabKey ?? selected.prefabKey ?? base.prefabKey;
    if (maxHp === undefined) throw new TypeError("enemy maxHp requires a defined value");
    if (moveSpeed === undefined) throw new TypeError("enemy moveSpeed requires a defined value");
    if (prefabKey === undefined) throw new TypeError("enemy prefabKey requires a defined value");
    return { id: source.Key, maxHp, moveSpeed, prefabKey,
        notCountInTotal: overridden.notCountInTotal ?? selected.notCountInTotal ?? base.notCountInTotal ?? false };
}

export function resolveEnemyMovementPrefabKey(value: unknown, level: number, overwrittenData?: unknown): string {
    return resolvedValues(value, level, overwrittenData).prefabKey;
}

export function parseEnemyMovementContent(
    value: unknown,
    level: number,
    profile: EnemyMovementPrefab,
    overwrittenData?: unknown,
): ArknightsEnemyMovementContent {
    const { id, maxHp, moveSpeed, prefabKey, notCountInTotal } = resolvedValues(value, level, overwrittenData);
    if (prefabKey !== profile.prefabKey) throw new TypeError(`enemy movement prefab does not match ${prefabKey}`);
    const definition = createEnemyDefinition({
        id,
        vitality: { maxHp },
        locomotion: {
            moveSpeedPerTick: perSecondToPerTick(moveSpeed),
            steeringParameters: profile.steeringParameters,
        },
    });
    return Object.freeze({ definition, alwaysCheckCurrentPoint: profile.alwaysCheckCurrentPoint,
        notCountInTotal, delayToBornTicks: profile.delayToBornTicks,
        onlyDelayToBornOnTileStart: profile.onlyDelayToBornOnTileStart });
}

export function parseEnemyMovementDefinition(
    value: unknown,
    level: number,
    profile: EnemyMovementPrefab,
    overwrittenData?: unknown,
): EnemyDefinition {
    return parseEnemyMovementContent(value, level, profile, overwrittenData).definition;
}
