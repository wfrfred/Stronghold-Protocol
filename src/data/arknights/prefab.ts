import {
    createSteeringParameters,
    type SteeringParameters,
} from "../../core/tactical/unit/locomotion/steering.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";
import { secondsToTicks } from "./tick.js";

export interface EnemyMovementPrefab {
    readonly prefabKey: string;
    readonly alwaysCheckCurrentPoint: boolean;
    readonly delayToBornTicks: number;
    readonly onlyDelayToBornOnTileStart: boolean;
    readonly steeringParameters: SteeringParameters;
}

export type PredefinedPrefab =
    | { readonly type: "UNIT"; readonly prefabKey: string; readonly walkCostFloor: number }
    | {
          readonly type: "MECHANISM";
          readonly prefabKey: string;
          readonly skillPrefabKey: string;
          readonly terrain: "MIRE" | "DEEPSEA";
      };

interface PrefabExtraction {
    readonly prefabKey: string;
    readonly components: readonly Record<string, unknown>[];
}

function object(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }
    return value as Record<string, unknown>;
}

function extraction(value: unknown): PrefabExtraction {
    const source = object(value, "prefab extraction");
    if (typeof source.prefabKey !== "string" || source.prefabKey.length === 0) {
        throw new TypeError("prefab extraction prefabKey must be nonempty");
    }
    if (!Array.isArray(source.components)) {
        throw new TypeError("prefab components must be an array");
    }
    const components: Record<string, unknown>[] = [];
    for (let index = 0; index < source.components.length; index++) {
        if (!Object.hasOwn(source.components, index)) {
            throw new TypeError("prefab components must be dense");
        }
        const component = object(source.components[index], `prefab component ${index}`);
        components.push(object(component.fields, `prefab component ${index} fields`));
    }
    return { prefabKey: source.prefabKey, components };
}

function component(source: PrefabExtraction, field: string): Record<string, unknown> {
    const matches = source.components.filter((value) => Object.hasOwn(value, field));
    if (matches.length !== 1) {
        throw new TypeError(`${source.prefabKey} requires one component with ${field}`);
    }
    return matches[0]!;
}

function boolean(value: unknown, name: string): boolean {
    if (typeof value !== "boolean") {
        throw new TypeError(`${name} must be boolean`);
    }
    return value;
}

function nonnegative(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be finite and nonnegative`);
    }
    return value;
}

export function parseEnemyMovementPrefab(value: unknown): EnemyMovementPrefab {
    const source = extraction(value);
    const enemy = component(source, "_alwaysCheckCurrentPoint");
    const movement = component(source, "_steeringFactor");
    return Object.freeze({
        prefabKey: source.prefabKey,
        alwaysCheckCurrentPoint: boolean(
            enemy._alwaysCheckCurrentPoint,
            "enemy _alwaysCheckCurrentPoint",
        ),
        delayToBornTicks: secondsToTicks(nonnegative(enemy._delayToBorn, "enemy _delayToBorn")),
        onlyDelayToBornOnTileStart: boolean(
            enemy._onlyDelayToBornOnTileStart,
            "enemy _onlyDelayToBornOnTileStart",
        ),
        steeringParameters: createSteeringParameters({
            steeringFactor:
                nonnegative(movement._steeringFactor, "movement _steeringFactor") /
                TICKS_PER_SECOND,
            maxSteeringForce:
                nonnegative(movement._maxSteeringForce, "movement _maxSteeringForce") /
                TICKS_PER_SECOND ** 2,
        }),
    });
}

function buffKeys(source: PrefabExtraction): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const fields of source.components) {
        if (!Object.hasOwn(fields, "_metadata") || !Array.isArray(fields._buffs)) {
            continue;
        }
        for (const value of fields._buffs) {
            const buff = object(value, "prefab buff");
            if (typeof buff.buffKey === "string") {
                keys.add(buff.buffKey);
            }
        }
    }
    return keys;
}

export function parsePredefinedPrefab(value: unknown, skillValue?: unknown): PredefinedPrefab {
    const source = extraction(value);
    const token = component(source, "_rewriteTileOptions");
    if (boolean(token._rewriteTileOptions, "token _rewriteTileOptions")) {
        const mode = component(source, "_tileOptions");
        const options = object(mode._tileOptions, "token mode tile options");
        if (
            mode._keepCurrentPassableMask !== true ||
            options.overrideObstacleLikeMoveCost !== true ||
            token._ignoreBlockAnyRoutes !== true ||
            options.buildableType !== 0 ||
            token._motionMode !== 0 ||
            token._blockMode !== 0
        ) {
            throw new TypeError(`unsupported spatial token profile ${source.prefabKey}`);
        }
        return Object.freeze({ type: "UNIT", prefabKey: source.prefabKey, walkCostFloor: 1000 });
    }
    if (token._disableUIHub !== true || token._withdrawable !== false || token._category !== 2) {
        throw new TypeError(`unsupported token mechanism profile ${source.prefabKey}`);
    }
    if (skillValue === undefined) {
        throw new TypeError(`${source.prefabKey} requires a skill prefab`);
    }
    const skill = extraction(skillValue);
    const keys = buffKeys(skill);
    const mire = keys.has("buff_mire[mark]") && keys.has("buff_mire[checker]");
    const deepsea = keys.has("sea_drown[enemy]") && keys.has("buff_sea");
    if (mire === deepsea) {
        throw new TypeError(`unsupported mechanism profile ${source.prefabKey}`);
    }
    return Object.freeze({
        type: "MECHANISM",
        prefabKey: source.prefabKey,
        skillPrefabKey: skill.prefabKey,
        terrain: mire ? "MIRE" : "DEEPSEA",
    });
}
