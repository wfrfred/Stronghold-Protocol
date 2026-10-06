import type { Seed } from "../../core/common/rng.js";
import { createBattleSpec, type BattleSpec } from "../../core/tactical/battle/spec.js";
import type { PredefinedInstanceDefinition } from "../../core/tactical/battle/predefined.js";
import type { ArknightsBlackboardEntry } from "./blackboard.js";
import type { ArknightsTileContext } from "./map.js";
import { parseEnemyMovementContent, resolveEnemyMovementPrefabKey } from "./enemy.js";
import {
    parseLevelDefinition,
    type ArknightsLevelDefinition,
    type ArknightsLevelMapContext,
    type ArknightsPredefinedInstance,
} from "./level.js";
import { parsePredefinedInstanceDefinition, resolvePredefinedPrefabKey } from "./predefined.js";
import { parseEnemyMovementPrefab, parsePredefinedPrefab } from "./prefab.js";
import { compileSpawnSchedule, type ArknightsScheduleSelection } from "./schedule.js";
import { resolvePredefinedSkillBlackboard, resolvePredefinedSkillId } from "./skill.js";
import { resolveTerrainMapOptions, type ArknightsTerrainController } from "./terrain.js";
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
    readonly spec: BattleSpec;
    readonly omittedActions: readonly string[];
    readonly inactiveBranches: readonly string[];
    readonly omittedPredefines: readonly string[];
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

function locatePredefines(context: ArknightsLevelMapContext): readonly LocatedPredefined[] {
    const instances: LocatedPredefined[] = [];

    for (const source of ["predefines", "hardPredefines"] as const) {
        for (const collection of ["characterInsts", "tokenInsts"] as const) {
            for (const [index, instance] of context[source][collection].entries()) {
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

export function loadMovementScenario(
    rawLevel: unknown,
    selection: ArknightsMovementSelection,
    catalog: ArknightsMovementCatalog,
    rngState: Seed,
): ArknightsMovementScenario {
    const predefines: PredefinedInstanceDefinition[] = [];
    const omittedPredefines: string[] = [];
    const unappliedTileBlackboard: {
        context: ArknightsTileContext;
        entry: ArknightsBlackboardEntry;
    }[] = [];

    const level = parseLevelDefinition(rawLevel, (context) => {
        const located = locatePredefines(context);
        const selected = new Set<string>();

        for (const item of selection.predefines) {
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

        const controllers: ArknightsTerrainController[] = [];

        for (const { id, path, instance } of located) {
            if (!selected.has(path)) {
                omittedPredefines.push(path);
                continue;
            }

            const character = catalog.character(instance.inst.characterKey);
            const skillId = resolvePredefinedSkillId(instance, character);
            const skill = resolvePredefinedSkillBlackboard(
                instance,
                character,
                catalog.skill(skillId),
            );
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

                controllers.push({ profile, skill });
            }

            predefines.push(parsePredefinedInstanceDefinition(id, instance, profile, character));
        }

        return {
            ...resolveTerrainMapOptions(controllers),
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
        };
    });

    if (!level.options.steeringEnabled || level.options.functionDisableMask !== "NONE") {
        throw new RangeError("unsupported level movement controls");
    }

    const compiled = compileSpawnSchedule(level, selection, (reference) => {
        const rawEnemy = catalog.enemy(reference.id);
        const prefabKey = resolveEnemyMovementPrefabKey(
            rawEnemy,
            reference.level,
            reference.overwrittenData,
        );
        const profile = parseEnemyMovementPrefab(catalog.prefab(prefabKey));

        return parseEnemyMovementContent(
            rawEnemy,
            reference.level,
            profile,
            reference.overwrittenData,
        );
    });

    return Object.freeze({
        level,
        spec: createBattleSpec({
            map: level.map,
            schedule: compiled.schedule,
            predefines,
            initialMechanisms: [],
            initialEffects: [],
            maxTicks: secondsToTicks(level.options.maxPlayTime),
            moveMultiplier: level.options.moveMultiplier,
            rngState,
            nextUnitId: 0,
            nextNavigationRequestId: 0,
        }),
        omittedActions: Object.freeze(compiled.omittedActions),
        inactiveBranches: Object.freeze(compiled.inactiveBranches),
        omittedPredefines: Object.freeze(omittedPredefines),
        unappliedLevelBlackboard: level.options.configBlackBoard ?? Object.freeze([]),
        unappliedTileBlackboard: Object.freeze(unappliedTileBlackboard),
    });
}
