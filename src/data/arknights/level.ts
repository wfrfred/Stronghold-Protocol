import type { BattlefieldMap } from "../../core/tactical/battlefield/map.js";
import { createTilePosition, type TilePosition } from "../../core/tactical/geometry/coordinate.js";
import { Direction } from "../../core/tactical/geometry/direction.js";
import type { RouteDefinition } from "../../core/tactical/route/definition.js";
import { parseBattlefieldMap, type ArknightsMapOptions } from "./map.js";
import { parseBlackboard, type ArknightsBlackboardEntry } from "./blackboard.js";
import { parseRouteDefinition } from "./route.js";

export type ArknightsJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ArknightsJsonValue[]
    | { readonly [key: string]: ArknightsJsonValue };

export interface ArknightsUnsupportedRule {
    readonly path: string;
    readonly reason: string;
}

export interface ArknightsLevelOptions {
    readonly characterLimit: number;
    readonly maxLifePoint: number;
    readonly initialCost: number;
    readonly maxCost: number;
    readonly costIncreaseTime: number;
    readonly moveMultiplier: number;
    readonly steeringEnabled: boolean;
    readonly isTrainingLevel: boolean;
    readonly isHardTrainingLevel: boolean;
    readonly isPredefinedCardsSelectable: boolean;
    readonly displayRestTime: boolean;
    readonly maxPlayTime: number;
    readonly functionDisableMask: string;
    readonly configBlackBoard: readonly ArknightsBlackboardEntry[] | null;
}

export interface ArknightsEnemyDbRef {
    readonly useDb: true;
    readonly id: string;
    readonly level: number;
    readonly overwrittenData: ArknightsJsonValue;
}

export interface ArknightsSpawnAction {
    readonly actionType: "SPAWN";
    readonly managedByScheduler: boolean;
    readonly key: string;
    readonly count: number;
    readonly preDelay: number;
    readonly interval: number;
    readonly routeIndex: number;
    readonly blockFragment: boolean;
    readonly autoPreviewRoute: boolean;
    readonly autoDisplayEnemyInfo: boolean;
    readonly isUnharmfulAndAlwaysCountAsKilled: boolean;
    readonly hiddenGroup: string | null;
    readonly randomSpawnGroupKey: string | null;
    readonly randomSpawnGroupPackKey: string | null;
    readonly randomType: string;
    readonly refreshType: string;
    readonly weight: number;
    readonly dontBlockWave: boolean;
    readonly forceBlockWaveInBranch: boolean;
}

export interface ArknightsFragment {
    readonly preDelay: number;
    readonly actions: readonly ArknightsSpawnAction[];
}

export interface ArknightsWave {
    readonly preDelay: number;
    readonly postDelay: number;
    readonly maxTimeWaitingForNextWave: number;
    readonly fragments: readonly ArknightsFragment[];
    readonly advancedWaveTag: string | null;
}

export interface ArknightsBranch {
    readonly phases: readonly ArknightsFragment[];
}

export interface ArknightsCharacterInstanceConfig {
    readonly characterKey: string;
    readonly level: number;
    readonly phase: "PHASE_0" | "PHASE_1" | "PHASE_2";
    readonly favorPoint: number;
    readonly potentialRank: number;
}

export interface ArknightsPredefinedInstance {
    readonly position: TilePosition;
    readonly direction: Direction;
    readonly hidden: boolean;
    readonly alias: string | null;
    readonly uniEquipIds: ArknightsJsonValue;
    readonly showSpIllust: boolean;
    readonly masterInfos: ArknightsJsonValue;
    readonly inst: ArknightsCharacterInstanceConfig;
    readonly skillIndex: number;
    readonly mainSkillLvl: number;
    readonly skinId: string | null;
    readonly tmplId: string | null;
    readonly overrideSkillBlackboard: readonly ArknightsBlackboardEntry[] | null;
    readonly overrideTalents: ArknightsJsonValue;
}

export interface ArknightsPredefines {
    readonly characterInsts: readonly ArknightsPredefinedInstance[];
    readonly tokenInsts: readonly ArknightsPredefinedInstance[];
    readonly characterCards: readonly never[];
    readonly tokenCards: readonly never[];
}

export interface ArknightsLevelMetadata {
    readonly levelId: string | null;
    readonly mapId: string | null;
    readonly bgmEvent: string | null;
    readonly environmentSe: string | null;
    readonly operaConfig: ArknightsJsonValue;
    readonly cameraPlugin: string | null;
}

export interface ArknightsLevelDefinition {
    readonly map: BattlefieldMap;
    readonly routes: readonly RouteDefinition[];
    readonly extraRoutes: readonly RouteDefinition[];
    readonly enemies: readonly never[];
    readonly enemyDbRefs: readonly ArknightsEnemyDbRef[];
    readonly waves: readonly ArknightsWave[];
    readonly branches: Readonly<Record<string, ArknightsBranch>>;
    readonly options: ArknightsLevelOptions;
    readonly predefines: ArknightsPredefines;
    readonly hardPredefines: ArknightsPredefines;
    readonly tilesDisallowToLocate: readonly TilePosition[];
    readonly runes: readonly never[] | null;
    readonly optionalRunes: readonly never[] | null;
    readonly globalBuffs: readonly never[] | null;
    readonly excludeCharIdList: readonly string[] | null;
    readonly randomSeed: number;
    readonly metadata: ArknightsLevelMetadata;
    readonly unsupportedRules: readonly ArknightsUnsupportedRule[];
}

function object(value: unknown, name: string, fields?: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }
    const source = value as Record<string, unknown>;
    if (fields !== undefined) {
        for (const key of Object.keys(source)) {
            if (!fields.includes(key)) {
                throw new TypeError(`${name} has unsupported field ${key}`);
            }
        }
    }
    return source;
}

function array<T>(
    value: unknown,
    name: string,
    parse: (value: unknown, name: string) => T,
): readonly T[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${name} must be an array`);
    }
    const result: T[] = [];
    for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index) || value[index] === undefined) {
            throw new TypeError(`${name} must be dense`);
        }
        result.push(parse(value[index], `${name}[${index}]`));
    }
    return Object.freeze(result);
}

function string(value: unknown, name: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${name} must be a string`);
    }
    return value;
}

function identifier(value: unknown, name: string): string {
    const result = string(value, name);
    if (result.length === 0) {
        throw new TypeError(`${name} must not be empty`);
    }
    return result;
}

function nullableString(value: unknown, name: string): string | null {
    return value === null ? null : string(value, name);
}

function number(value: unknown, name: string, minimum = -Infinity): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
        throw new RangeError(`${name} must be finite and at least ${minimum}`);
    }
    return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
    const result = number(value, name, minimum);
    if (!Number.isSafeInteger(result)) {
        throw new RangeError(`${name} must be a safe integer`);
    }
    return result;
}

function boolean(value: unknown, name: string): boolean {
    if (typeof value !== "boolean") {
        throw new TypeError(`${name} must be boolean`);
    }
    return value;
}

function position(value: unknown, name: string): TilePosition {
    const source = object(value, name, ["row", "col"]);
    return createTilePosition(
        integer(source.row, `${name}.row`, -Number.MAX_SAFE_INTEGER),
        integer(source.col, `${name}.col`, -Number.MAX_SAFE_INTEGER),
    );
}

function emptyArray(value: unknown, name: string): readonly never[] {
    if (!Array.isArray(value) || value.length !== 0) {
        throw new TypeError(`${name} is not supported unless empty`);
    }
    return Object.freeze([]);
}

function nullableEmptyArray(value: unknown, name: string): readonly never[] | null {
    return value === null ? null : emptyArray(value, name);
}

function json(value: unknown, name: string, ancestors = new Set<object>()): ArknightsJsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return number(value, name);
    }
    if (typeof value !== "object") {
        throw new TypeError(`${name} must contain JSON values`);
    }
    if (ancestors.has(value)) {
        throw new TypeError(`${name} must not be cyclic`);
    }
    ancestors.add(value);
    let result: ArknightsJsonValue;
    if (Array.isArray(value)) {
        result = array(value, name, (item, path) => json(item, path, ancestors));
    } else {
        result = Object.freeze(
            Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                    key,
                    json(item, `${name}.${key}`, ancestors),
                ]),
            ),
        );
    }
    ancestors.delete(value);
    return result;
}

function blackboard(value: unknown, name: string): readonly ArknightsBlackboardEntry[] | null {
    if (value === null) {
        return null;
    }
    return parseBlackboard(value, name);
}

function options(value: unknown): ArknightsLevelOptions {
    const source = object(value, "level.options", [
        "characterLimit",
        "maxLifePoint",
        "initialCost",
        "maxCost",
        "costIncreaseTime",
        "moveMultiplier",
        "steeringEnabled",
        "isTrainingLevel",
        "isHardTrainingLevel",
        "isPredefinedCardsSelectable",
        "displayRestTime",
        "maxPlayTime",
        "functionDisableMask",
        "configBlackBoard",
    ]);
    return Object.freeze({
        characterLimit: integer(source.characterLimit, "level.options.characterLimit"),
        maxLifePoint: integer(source.maxLifePoint, "level.options.maxLifePoint"),
        initialCost: number(source.initialCost, "level.options.initialCost", 0),
        maxCost: number(source.maxCost, "level.options.maxCost", 0),
        costIncreaseTime: number(source.costIncreaseTime, "level.options.costIncreaseTime", 0),
        moveMultiplier: number(source.moveMultiplier, "level.options.moveMultiplier", 0),
        steeringEnabled: boolean(source.steeringEnabled, "level.options.steeringEnabled"),
        isTrainingLevel: boolean(source.isTrainingLevel, "level.options.isTrainingLevel"),
        isHardTrainingLevel: boolean(
            source.isHardTrainingLevel,
            "level.options.isHardTrainingLevel",
        ),
        isPredefinedCardsSelectable: boolean(
            source.isPredefinedCardsSelectable,
            "level.options.isPredefinedCardsSelectable",
        ),
        displayRestTime: boolean(source.displayRestTime, "level.options.displayRestTime"),
        maxPlayTime: number(source.maxPlayTime, "level.options.maxPlayTime", -1),
        functionDisableMask: identifier(
            source.functionDisableMask,
            "level.options.functionDisableMask",
        ),
        configBlackBoard: blackboard(source.configBlackBoard, "level.options.configBlackBoard"),
    });
}

function enemyDbRef(
    value: unknown,
    name: string,
    unsupported: ArknightsUnsupportedRule[],
): ArknightsEnemyDbRef {
    const source = object(value, name, ["useDb", "id", "level", "overwrittenData"]);
    if (source.useDb !== true) {
        throw new TypeError(`${name}.useDb=false is not supported`);
    }
    let overwrittenData: ArknightsJsonValue = null;
    if (source.overwrittenData !== null) {
        object(source.overwrittenData, `${name}.overwrittenData`, [
            "name",
            "description",
            "prefabKey",
            "attributes",
            "applyWay",
            "motion",
            "enemyTags",
            "lifePointReduce",
            "levelType",
            "rangeRadius",
            "numOfExtraDrops",
            "viewRadius",
            "notCountInTotal",
            "talentBlackboard",
            "skills",
            "spData",
        ]);
        overwrittenData = json(source.overwrittenData, `${name}.overwrittenData`);
        unsupported.push(
            Object.freeze({
                path: `${name}.overwrittenData`,
                reason: "enemy attribute overrides require a content resolver",
            }),
        );
    }
    return Object.freeze({
        useDb: true,
        id: identifier(source.id, `${name}.id`),
        level: integer(source.level, `${name}.level`),
        overwrittenData,
    });
}

function action(
    value: unknown,
    name: string,
    routeCount: number,
    enemyIds: ReadonlySet<string>,
): ArknightsSpawnAction {
    const source = object(value, name, [
        "actionType",
        "managedByScheduler",
        "key",
        "count",
        "preDelay",
        "interval",
        "routeIndex",
        "blockFragment",
        "autoPreviewRoute",
        "autoDisplayEnemyInfo",
        "isUnharmfulAndAlwaysCountAsKilled",
        "hiddenGroup",
        "randomSpawnGroupKey",
        "randomSpawnGroupPackKey",
        "randomType",
        "refreshType",
        "weight",
        "dontBlockWave",
        "forceBlockWaveInBranch",
    ]);
    if (source.actionType !== "SPAWN") {
        throw new RangeError(`${name} has unsupported actionType ${String(source.actionType)}`);
    }
    const routeIndex = integer(source.routeIndex, `${name}.routeIndex`);
    if (routeIndex >= routeCount) {
        throw new RangeError(`${name} references missing route ${routeIndex}`);
    }
    const key = identifier(source.key, `${name}.key`);
    if (!enemyIds.has(key)) {
        throw new RangeError(`${name} references missing enemy ${key}`);
    }
    return Object.freeze({
        actionType: "SPAWN",
        managedByScheduler: boolean(source.managedByScheduler, `${name}.managedByScheduler`),
        key,
        count: integer(source.count, `${name}.count`, 1),
        preDelay: number(source.preDelay, `${name}.preDelay`, 0),
        interval: number(source.interval, `${name}.interval`, 0),
        routeIndex,
        blockFragment: boolean(source.blockFragment, `${name}.blockFragment`),
        autoPreviewRoute: boolean(source.autoPreviewRoute, `${name}.autoPreviewRoute`),
        autoDisplayEnemyInfo: boolean(source.autoDisplayEnemyInfo, `${name}.autoDisplayEnemyInfo`),
        isUnharmfulAndAlwaysCountAsKilled: boolean(
            source.isUnharmfulAndAlwaysCountAsKilled,
            `${name}.isUnharmfulAndAlwaysCountAsKilled`,
        ),
        hiddenGroup: nullableString(source.hiddenGroup, `${name}.hiddenGroup`),
        randomSpawnGroupKey: nullableString(
            source.randomSpawnGroupKey,
            `${name}.randomSpawnGroupKey`,
        ),
        randomSpawnGroupPackKey: nullableString(
            source.randomSpawnGroupPackKey,
            `${name}.randomSpawnGroupPackKey`,
        ),
        randomType: identifier(source.randomType, `${name}.randomType`),
        refreshType: identifier(source.refreshType, `${name}.refreshType`),
        weight: number(source.weight, `${name}.weight`, 0),
        dontBlockWave: boolean(source.dontBlockWave, `${name}.dontBlockWave`),
        forceBlockWaveInBranch: boolean(
            source.forceBlockWaveInBranch,
            `${name}.forceBlockWaveInBranch`,
        ),
    });
}

function fragment(
    value: unknown,
    name: string,
    routeCount: number,
    enemyIds: ReadonlySet<string>,
): ArknightsFragment {
    const source = object(value, name, ["preDelay", "actions"]);
    return Object.freeze({
        preDelay: number(source.preDelay, `${name}.preDelay`, 0),
        actions: array(source.actions, `${name}.actions`, (item, path) =>
            action(item, path, routeCount, enemyIds),
        ),
    });
}

function predefinedInstance(
    value: unknown,
    name: string,
    unsupported: ArknightsUnsupportedRule[],
): ArknightsPredefinedInstance {
    const source = object(value, name, [
        "position",
        "direction",
        "hidden",
        "alias",
        "uniEquipIds",
        "showSpIllust",
        "masterInfos",
        "inst",
        "skillIndex",
        "mainSkillLvl",
        "skinId",
        "tmplId",
        "overrideSkillBlackboard",
        "overrideTalents",
    ]);
    const inst = object(source.inst, `${name}.inst`, [
        "characterKey",
        "level",
        "phase",
        "favorPoint",
        "potentialRank",
    ]);
    const phase = inst.phase;
    if (phase !== "PHASE_0" && phase !== "PHASE_1" && phase !== "PHASE_2") {
        throw new RangeError(`${name}.inst.phase is unsupported`);
    }
    const direction = source.direction;
    if (!Direction.is(direction)) {
        throw new RangeError(`${name}.direction is unsupported`);
    }
    for (const key of ["uniEquipIds", "masterInfos", "overrideTalents"] as const) {
        const value = source[key];
        if (value !== null && (!Array.isArray(value) || value.length !== 0)) {
            unsupported.push(
                Object.freeze({
                    path: `${name}.${key}`,
                    reason: "predefined content configuration requires a content resolver",
                }),
            );
        }
    }
    return Object.freeze({
        position: position(source.position, `${name}.position`),
        direction,
        hidden: boolean(source.hidden, `${name}.hidden`),
        alias: nullableString(source.alias, `${name}.alias`),
        uniEquipIds: json(source.uniEquipIds, `${name}.uniEquipIds`),
        showSpIllust: boolean(source.showSpIllust, `${name}.showSpIllust`),
        masterInfos: json(source.masterInfos, `${name}.masterInfos`),
        inst: Object.freeze({
            characterKey: identifier(inst.characterKey, `${name}.inst.characterKey`),
            level: integer(inst.level, `${name}.inst.level`, 1),
            phase,
            favorPoint: integer(inst.favorPoint, `${name}.inst.favorPoint`),
            potentialRank: integer(inst.potentialRank, `${name}.inst.potentialRank`),
        }),
        skillIndex: integer(source.skillIndex, `${name}.skillIndex`, -1),
        mainSkillLvl: integer(source.mainSkillLvl, `${name}.mainSkillLvl`, 1),
        skinId: nullableString(source.skinId, `${name}.skinId`),
        tmplId: nullableString(source.tmplId, `${name}.tmplId`),
        overrideSkillBlackboard: blackboard(
            source.overrideSkillBlackboard,
            `${name}.overrideSkillBlackboard`,
        ),
        overrideTalents: json(source.overrideTalents, `${name}.overrideTalents`),
    });
}

function predefines(
    value: unknown,
    name: string,
    unsupported: ArknightsUnsupportedRule[],
): ArknightsPredefines {
    const source = object(value, name, [
        "characterInsts",
        "tokenInsts",
        "characterCards",
        "tokenCards",
    ]);
    return Object.freeze({
        characterInsts: array(source.characterInsts, `${name}.characterInsts`, (item, path) =>
            predefinedInstance(item, path, unsupported),
        ),
        tokenInsts: array(source.tokenInsts, `${name}.tokenInsts`, (item, path) =>
            predefinedInstance(item, path, unsupported),
        ),
        characterCards: emptyArray(source.characterCards, `${name}.characterCards`),
        tokenCards: emptyArray(source.tokenCards, `${name}.tokenCards`),
    });
}

export interface ArknightsLevelMapContext {
    readonly predefines: ArknightsPredefines;
    readonly hardPredefines: ArknightsPredefines;
    readonly options: ArknightsLevelOptions;
}

export function parseLevelDefinition(
    value: unknown,
    resolveMapOptions: (context: ArknightsLevelMapContext) => ArknightsMapOptions = () => ({}),
): ArknightsLevelDefinition {
    const source = object(value, "level", [
        "options",
        "levelId",
        "mapId",
        "bgmEvent",
        "environmentSe",
        "mapData",
        "tilesDisallowToLocate",
        "runes",
        "optionalRunes",
        "globalBuffs",
        "routes",
        "extraRoutes",
        "enemies",
        "enemyDbRefs",
        "waves",
        "branches",
        "predefines",
        "hardPredefines",
        "excludeCharIdList",
        "randomSeed",
        "operaConfig",
        "cameraPlugin",
    ]);
    const unsupported: ArknightsUnsupportedRule[] = [];
    const routes = array(source.routes, "level.routes", (item) => parseRouteDefinition(item));
    const extraRoutes = array(source.extraRoutes, "level.extraRoutes", (item) =>
        parseRouteDefinition(item),
    );
    const enemyIds = new Set<string>();
    const enemyDbRefs = array(source.enemyDbRefs, "level.enemyDbRefs", (item, path) => {
        const reference = enemyDbRef(item, path, unsupported);
        if (enemyIds.has(reference.id)) {
            throw new TypeError(`level.enemyDbRefs has duplicate enemy ${reference.id}`);
        }
        enemyIds.add(reference.id);
        return reference;
    });
    const waves = array(source.waves, "level.waves", (item, path) => {
        const wave = object(item, path, [
            "preDelay",
            "postDelay",
            "maxTimeWaitingForNextWave",
            "fragments",
            "advancedWaveTag",
        ]);
        const maxTimeWaitingForNextWave = number(
            wave.maxTimeWaitingForNextWave,
            `${path}.maxTimeWaitingForNextWave`,
            -1,
        );
        if (maxTimeWaitingForNextWave < 0 && maxTimeWaitingForNextWave !== -1) {
            throw new RangeError(`${path}.maxTimeWaitingForNextWave must be -1 or non-negative`);
        }
        return Object.freeze({
            preDelay: number(wave.preDelay, `${path}.preDelay`, 0),
            postDelay: number(wave.postDelay, `${path}.postDelay`, 0),
            maxTimeWaitingForNextWave,
            fragments: array(wave.fragments, `${path}.fragments`, (part, name) =>
                fragment(part, name, routes.length, enemyIds),
            ),
            advancedWaveTag: nullableString(wave.advancedWaveTag, `${path}.advancedWaveTag`),
        });
    });
    const branches = Object.freeze(
        Object.fromEntries(
            Object.entries(
                source.branches === null ? {} : object(source.branches, "level.branches"),
            ).map(([key, item]) => {
                identifier(key, "level branch name");
                const path = `level.branches.${key}`;
                const branch = object(item, path, ["phases"]);
                return [
                    key,
                    Object.freeze({
                        phases: array(branch.phases, `${path}.phases`, (part, name) =>
                            fragment(part, name, extraRoutes.length, enemyIds),
                        ),
                    }),
                ];
            }),
        ),
    );
    const predefined = predefines(source.predefines, "level.predefines", unsupported);
    const hardPredefined = predefines(source.hardPredefines, "level.hardPredefines", unsupported);
    const levelOptions = options(source.options);
    const mapOptions = resolveMapOptions({
        predefines: predefined,
        hardPredefines: hardPredefined,
        options: levelOptions,
    });
    const randomSeed = integer(source.randomSeed, "level.randomSeed", -(2 ** 31));
    if (randomSeed >= 2 ** 31) {
        throw new RangeError("level.randomSeed must be a signed 32-bit integer");
    }
    return Object.freeze({
        map: parseBattlefieldMap(source.mapData, mapOptions),
        routes,
        extraRoutes,
        enemies: emptyArray(source.enemies, "level.enemies"),
        enemyDbRefs,
        waves,
        branches,
        options: levelOptions,
        predefines: predefined,
        hardPredefines: hardPredefined,
        tilesDisallowToLocate: array(
            source.tilesDisallowToLocate,
            "level.tilesDisallowToLocate",
            position,
        ),
        runes: nullableEmptyArray(source.runes, "level.runes"),
        optionalRunes: nullableEmptyArray(source.optionalRunes, "level.optionalRunes"),
        globalBuffs: nullableEmptyArray(source.globalBuffs, "level.globalBuffs"),
        excludeCharIdList:
            source.excludeCharIdList === null
                ? null
                : array(source.excludeCharIdList, "level.excludeCharIdList", string),
        randomSeed,
        metadata: Object.freeze({
            levelId: nullableString(source.levelId, "level.levelId"),
            mapId: nullableString(source.mapId, "level.mapId"),
            bgmEvent: nullableString(source.bgmEvent, "level.bgmEvent"),
            environmentSe: nullableString(source.environmentSe, "level.environmentSe"),
            operaConfig: json(source.operaConfig, "level.operaConfig"),
            cameraPlugin: nullableString(source.cameraPlugin, "level.cameraPlugin"),
        }),
        unsupportedRules: Object.freeze(unsupported),
    });
}
