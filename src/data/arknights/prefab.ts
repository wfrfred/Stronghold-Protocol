import { assertNonnegativeNumber } from "../../core/common/assert.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";
import type {
    DeploymentProfile,
    TileBindingDefinition,
} from "../../core/tactical/unit/capability/deployment.js";
import {
    createSteeringParameters,
    type SteeringParameters,
} from "../../core/tactical/unit/capability/locomotion/steering.js";
import { secondsToTicks } from "./tick.js";

export interface EnemyMovementPrefab {
    readonly prefabKey: string;
    readonly alwaysCheckCurrentPoint: boolean;
    readonly delayToBornTicks: number;
    readonly onlyDelayToBornOnTileStart: boolean;
    readonly steeringParameters: SteeringParameters;
}

export interface TileDeploymentPrefab {
    readonly prefabKey: string;
    readonly advancedBuildableMask: number;
}

export type PredefinedPrefab =
    | {
          readonly type: "UNIT";
          readonly prefabKey: string;
          readonly walkCostFloor: number;
          readonly tileBinding: TileBindingDefinition;
          readonly deployment: DeploymentProfile;
      }
    | {
          readonly type: "MECHANISM";
          readonly prefabKey: string;
          readonly skillPrefabKey: string;
          readonly terrain: "MIRE" | "DEEPSEA";
      };

interface PrefabExtraction {
    readonly prefabKey: string;
    readonly components: readonly Record<string, unknown>[];
    readonly objects: ReadonlyMap<string, Record<string, unknown>>;
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
    const objects = new Map<string, Record<string, unknown>>();

    for (let index = 0; index < source.components.length; index++) {
        if (!Object.hasOwn(source.components, index)) {
            throw new TypeError("prefab components must be dense");
        }

        const component = object(source.components[index], `prefab component ${index}`);
        const fields = object(component.fields, `prefab component ${index} fields`);
        components.push(fields);

        if (component.object !== undefined) {
            const record = object(component.object, `prefab component ${index} object`);

            if (typeof record.id !== "string" || record.id.length === 0 || objects.has(record.id)) {
                throw new TypeError(`invalid prefab component object id at index ${index}`);
            }

            objects.set(record.id, fields);
        }
    }

    return { prefabKey: source.prefabKey, components, objects };
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
    assertNonnegativeNumber(value, name);

    return value;
}

function advancedBuildableMask(value: unknown, name: string): number {
    const mask = nonnegative(value, name);

    if (!Number.isInteger(mask) || mask > 0xffff_ffff) {
        throw new RangeError(`${name} must be a uint32`);
    }

    return mask;
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

export function parseTileDeploymentPrefab(value: unknown): TileDeploymentPrefab {
    const source = extraction(value);
    const tile = component(source, "_tileKey");
    const mask = advancedBuildableMask(tile._advancedBuildableMask, "tile _advancedBuildableMask");

    if (tile._tileKey !== source.prefabKey) {
        throw new TypeError(`unsupported tile deployment profile ${source.prefabKey}`);
    }

    return Object.freeze({ prefabKey: source.prefabKey, advancedBuildableMask: mask });
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

function tokenMode(
    source: PrefabExtraction,
    token: Record<string, unknown>,
): Record<string, unknown> {
    if (!Array.isArray(token._modes) || token._modes.length !== 1) {
        throw new TypeError(`${source.prefabKey} requires one token mode`);
    }

    const reference = object(token._modes[0], "token mode reference");

    if (reference.m_FileID !== 0 || typeof reference.m_PathID !== "string") {
        throw new TypeError(`${source.prefabKey} requires a local token mode reference`);
    }

    const mode = source.objects.get(reference.m_PathID);

    if (mode === undefined) {
        throw new TypeError(`${source.prefabKey} token mode is missing`);
    }

    return mode;
}

function tileBinding(
    mode: Record<string, unknown>,
    options: Record<string, unknown>,
): TileBindingDefinition {
    const buildableType = options.buildableType;
    let heightType: TileBindingDefinition["heightType"] = null;
    let advancedMask: TileBindingDefinition["advancedBuildableMask"] = null;

    if (buildableType !== 0 && buildableType !== 2 && buildableType !== 3) {
        throw new TypeError("unsupported token mode buildable type");
    }
    if (boolean(mode._rewriteTileHeightType, "token mode _rewriteTileHeightType")) {
        if (options.heightType !== 0 && options.heightType !== 1) {
            throw new TypeError("unsupported token mode height type");
        }

        heightType = options.heightType === 0 ? "LOWLAND" : "HIGHLAND";
    }
    if (boolean(mode._rewriteTileAdvancedBuildMask, "token mode _rewriteTileAdvancedBuildMask")) {
        advancedMask = advancedBuildableMask(
            options.advancedBuildMask,
            "token mode advancedBuildMask",
        );
    }

    return Object.freeze({
        heightType,
        buildableType: ({ 0: "NONE", 2: "RANGED", 3: "ALL" } as const)[buildableType],
        advancedBuildableMask: advancedMask,
    });
}

function deployment(token: Record<string, unknown>): DeploymentProfile {
    const condition = object(token._buildCondition, "token build condition");
    const extra = object(condition.extraBuildConditionArray, "token extra build condition");
    const buildableType = condition.buildableType;

    if (buildableType !== 1 && buildableType !== 2 && buildableType !== 3) {
        throw new TypeError("unsupported token deployment buildable type");
    }

    boolean(condition.needSpecifyDirection, "token deployment needSpecifyDirection");

    for (const key of [
        "isTryingOverlapCharacater",
        "limitByHostAttackRange",
        "limitByHostAbilityRange",
        "canNotBuildInHostAttackRange",
        "excludeNoTargetTile",
        "checkManuallyBuildableType",
        "_excludeOccupiedByWalkEnemy",
        "allowWalkEnemyInHostRange",
        "_checkUpdateBuildable",
    ]) {
        if (condition[key] !== false) {
            throw new TypeError(`unsupported token deployment condition ${key}`);
        }
    }
    if (
        condition.abilityName !== "" ||
        condition.tileKey !== "" ||
        condition.extraLocateRange !== "" ||
        condition.manuallyBuildableType !== 0 ||
        typeof extra.SerializedState !== "string" ||
        !Array.isArray(extra.SerializedObjectReferences) ||
        extra.SerializedObjectReferences.length !== 0
    ) {
        throw new TypeError("unsupported token extra deployment condition");
    }

    const serialized: unknown = JSON.parse(extra.SerializedState);

    if (serialized !== null && (!Array.isArray(serialized) || serialized.length !== 0)) {
        throw new TypeError("unsupported token serialized deployment condition");
    }

    return Object.freeze({
        buildableType: ({ 1: "MELEE", 2: "RANGED", 3: "ALL" } as const)[buildableType],
        advancedBuildableMask: advancedBuildableMask(
            condition.advancedBuildableMask,
            "token deployment advancedBuildableMask",
        ),
    });
}

export function parsePredefinedPrefab(value: unknown, skillValue?: unknown): PredefinedPrefab {
    const source = extraction(value);
    const token = component(source, "_rewriteTileOptions");

    if (boolean(token._rewriteTileOptions, "token _rewriteTileOptions")) {
        const mode = tokenMode(source, token);
        const options = object(mode._tileOptions, "token mode tile options");

        if (
            mode._keepCurrentPassableMask !== true ||
            mode._keepCurrentBuildableType !== false ||
            options.overrideObstacleLikeMoveCost !== true ||
            token._ignoreBlockAnyRoutes !== true ||
            token._motionMode !== 0 ||
            token._blockMode !== 0
        ) {
            throw new TypeError(`unsupported spatial token profile ${source.prefabKey}`);
        }

        return Object.freeze({
            type: "UNIT",
            prefabKey: source.prefabKey,
            walkCostFloor: 1000,
            tileBinding: tileBinding(mode, options),
            deployment: deployment(token),
        });
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
