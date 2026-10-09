import type { Seed } from "../../core/common/rng.js";
import type { Input } from "../../core/tactical/battle/contract.js";
import type { PredefinedInstanceDefinition } from "../../core/tactical/battle/steps/predefined.js";
import type { ArknightsBlackboardEntry } from "./blackboard.js";
import type { ArknightsMapOptions, ArknightsTileContext } from "./map.js";
import {
    createEnemyMovementContent,
    resolveEnemyMovementValues,
    type ArknightsEnemyMovementContent,
} from "./enemy.js";
import {
    createLevelDefinition,
    parseLevelContent,
    type ArknightsContentIssue,
    type ArknightsEnemyDbRef,
    type ArknightsLevelContent,
    type ArknightsLevelDefinition,
    type ArknightsPredefinedInstance,
} from "./level.js";
import { parsePredefinedInstanceDefinition, resolvePredefinedPrefabKey } from "./predefined.js";
import {
    parseEnemyMovementPrefab,
    parsePredefinedPrefab,
    parseTileDeploymentPrefab,
} from "./prefab.js";
import { compileSpawnSchedule, type ArknightsScheduleSelection } from "./schedule.js";
import { resolvePredefinedSkillBlackboard, resolvePredefinedSkillId } from "./skill.js";
import { resolveTerrainControllers, type ArknightsTerrainController } from "./terrain.js";
import { secondsToTicks } from "./tick.js";

export interface ArknightsMovementCatalog {
    readonly character: (key: string) => unknown;
    readonly skill: (key: string) => unknown;
    readonly enemy: (key: string) => unknown;
    readonly prefab: (key: string) => unknown;
}

export interface ArknightsPredefinedSelection {
    readonly source: "predefines" | "hardPredefines";
    readonly collection: "characterInsts" | "tokenInsts";
    readonly index: number;
}

export interface ArknightsMovementSelection extends ArknightsScheduleSelection {
    readonly predefines: readonly ArknightsPredefinedSelection[];
}

export interface ArknightsMovementScenario {
    readonly level: ArknightsLevelDefinition;
    readonly spec: Input;
    readonly omittedActions: readonly string[];
    readonly inactiveBranches: readonly string[];
    readonly omittedPredefines: readonly string[];
    readonly unsupportedRules: readonly ArknightsContentIssue[];
    readonly unappliedLevelBlackboard: readonly ArknightsBlackboardEntry[];
    readonly unappliedTileBlackboard: readonly {
        readonly context: ArknightsTileContext;
        readonly entry: ArknightsBlackboardEntry;
    }[];
}

interface LocatedPredefined {
    readonly id: number;
    readonly path: string;
    readonly instance: ArknightsPredefinedInstance;
}

function predefinedPath(selection: ArknightsPredefinedSelection): string {
    return `${selection.source}.${selection.collection}[${selection.index}]`;
}

function locatePredefines(content: ArknightsLevelContent): readonly LocatedPredefined[] {
    const instances: LocatedPredefined[] = [];

    for (const source of ["predefines", "hardPredefines"] as const) {
        for (const collection of ["characterInsts", "tokenInsts"] as const) {
            for (const [index, instance] of content[source][collection].entries()) {
                instances.push({
                    id: instances.length,
                    path: predefinedPath({ source, collection, index }),
                    instance,
                });
            }
        }
    }

    return instances;
}

function selectPredefines(
    content: ArknightsLevelContent,
    selections: readonly ArknightsPredefinedSelection[],
) {
    const located = locatePredefines(content);
    const selected = new Set<string>();

    for (const item of selections) {
        const path = predefinedPath(item);

        if (
            !Number.isSafeInteger(item.index) ||
            item.index < 0 ||
            selected.has(path) ||
            !located.some((instance) => instance.path === path)
        ) {
            throw new RangeError(
                `predefined selection requires unique existing instances: ${path}`,
            );
        }

        selected.add(path);
    }

    return {
        selected: located.filter(({ path }) => selected.has(path)),
        omitted: located.filter(({ path }) => !selected.has(path)).map(({ path }) => path),
    };
}

function loadPredefines(selected: readonly LocatedPredefined[], catalog: ArknightsMovementCatalog) {
    const predefines: PredefinedInstanceDefinition[] = [];
    const controllers: (ArknightsTerrainController & { readonly path: string })[] = [];
    const unsupportedRules: ArknightsContentIssue[] = [];

    for (const { id, path, instance } of selected) {
        const character = catalog.character(instance.inst.characterKey);
        const skillId = resolvePredefinedSkillId(instance, character);
        const skill = resolvePredefinedSkillBlackboard(instance, character, catalog.skill(skillId));
        const prefabKey = resolvePredefinedPrefabKey(instance, character);
        const profile = parsePredefinedPrefab(
            catalog.prefab(prefabKey),
            skill.prefabKey === null ? undefined : catalog.prefab(skill.prefabKey),
        );

        if (profile.type === "MECHANISM") {
            if (instance.hidden) {
                throw new RangeError(
                    "hidden terrain controllers require dynamic terrain activation",
                );
            }

            controllers.push({ profile, skill, path });
        } else {
            for (const entry of skill.blackboard) {
                unsupportedRules.push(
                    Object.freeze({
                        path: `level.${path}.skill.blackboard.${entry.key}`,
                        reason: "predefined unit skill blackboard is not applied by movement scenarios",
                    }),
                );
            }
        }

        predefines.push(parsePredefinedInstanceDefinition(id, instance, profile, character));
    }

    return { predefines, controllers, unsupportedRules };
}

function createMovementLevel(
    content: ArknightsLevelContent,
    terrain: ArknightsMapOptions,
    catalog: ArknightsMovementCatalog,
) {
    const unappliedTileBlackboard: {
        context: ArknightsTileContext;
        entry: ArknightsBlackboardEntry;
    }[] = [];
    const level = createLevelDefinition(content, {
        ...terrain,
        tileDeploymentPrefabs:
            terrain.deepsea === undefined
                ? []
                : [parseTileDeploymentPrefab(catalog.prefab("tile_deepsea"))],
        consumeTileBlackboard: (context, entry) => {
            if (entry.key !== "isValidHand" && entry.key !== "previewNotAlloed") {
                return false;
            }
            if (entry.valueStr !== null || (entry.value !== 0 && entry.value !== 1)) {
                throw new TypeError(`invalid movement-external tile flag ${entry.key}`);
            }

            unappliedTileBlackboard.push(Object.freeze({ context, entry }));

            return true;
        },
    });

    return { level, unappliedTileBlackboard };
}

export function loadMovementScenario(
    rawLevel: unknown,
    selection: ArknightsMovementSelection,
    catalog: ArknightsMovementCatalog,
    rngState: Seed,
): ArknightsMovementScenario {
    const content = parseLevelContent(rawLevel);

    if (!content.options.steeringEnabled || content.options.functionDisableMask !== "NONE") {
        throw new RangeError("unsupported level movement controls");
    }

    const predefinedSelection = selectPredefines(content, selection.predefines);
    const loaded = loadPredefines(predefinedSelection.selected, catalog);
    const terrain = resolveTerrainControllers(loaded.controllers);
    const { level, unappliedTileBlackboard } = createMovementLevel(
        content,
        terrain.mapOptions,
        catalog,
    );
    const resolvedEnemies = new Map<ArknightsEnemyDbRef, ArknightsEnemyMovementContent>();
    const compiled = compileSpawnSchedule(level, selection, (reference) => {
        const existing = resolvedEnemies.get(reference);

        if (existing !== undefined) {
            return existing;
        }

        const values = resolveEnemyMovementValues(
            catalog.enemy(reference.id),
            reference.level,
            reference.overwrittenData,
        );
        const profile = parseEnemyMovementPrefab(catalog.prefab(values.prefabKey));
        const enemy = createEnemyMovementContent(values, profile);
        resolvedEnemies.set(reference, enemy);

        return enemy;
    });
    const unappliedLevelBlackboard = level.options.configBlackBoard ?? Object.freeze([]);
    const unsupportedRules: ArknightsContentIssue[] = [
        ...loaded.unsupportedRules,
        ...terrain.unappliedBlackboard.map(({ controllerIndex, entry }) =>
            Object.freeze({
                path: `level.${loaded.controllers[controllerIndex]!.path}.skill.blackboard.${entry.key}`,
                reason: "terrain controller blackboard is not applied by movement scenarios",
            }),
        ),
        ...unappliedLevelBlackboard.map((entry, index) =>
            Object.freeze({
                path: `level.options.configBlackBoard[${index}]`,
                reason: `level blackboard ${entry.key} is not applied by movement scenarios`,
            }),
        ),
        ...unappliedTileBlackboard.map(({ context, entry }) =>
            Object.freeze({
                path: `level.map[${context.position[0]}][${context.position[1]}].blackboard.${entry.key}`,
                reason: "tile blackboard flag is not applied by movement scenarios",
            }),
        ),
    ];

    return Object.freeze({
        level,
        spec: {
            map: level.map,
            schedule: compiled.schedule,
            predefines: loaded.predefines,
            initialUnits: [],
            initialMechanisms: [],
            initialNavigationModifiers: [],
            maxTicks: secondsToTicks(level.options.maxPlayTime),
            routeMoveMultiplier: level.options.moveMultiplier,
            rngState,
        } satisfies Input,
        omittedActions: Object.freeze(compiled.omittedActions),
        inactiveBranches: Object.freeze(compiled.inactiveBranches),
        omittedPredefines: Object.freeze(predefinedSelection.omitted),
        unsupportedRules: Object.freeze(unsupportedRules),
        unappliedLevelBlackboard,
        unappliedTileBlackboard: Object.freeze(unappliedTileBlackboard),
    });
}
