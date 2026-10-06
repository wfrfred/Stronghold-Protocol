import type {
    BranchDefinition,
    FragmentDefinition,
    SpawnActionDefinition,
    SpawnScheduleDefinition,
} from "../../core/tactical/battle/schedule.js";
import type { EnemySpawnDefinition } from "../../core/tactical/battle/spawning.js";
import type { RouteDefinition } from "../../core/tactical/route/definition.js";
import type { ArknightsEnemyMovementContent } from "./enemy.js";
import type {
    ArknightsEnemyDbRef,
    ArknightsLevelDefinition,
    ArknightsSpawnAction,
} from "./level.js";
import { secondsToTicks } from "./tick.js";

export interface ArknightsActionSelection {
    readonly waveIndex: number;
    readonly fragmentIndex: number;
    readonly actionIndex: number;
}

export interface ArknightsScheduleSelection {
    readonly actions: readonly ArknightsActionSelection[];
    readonly branches: readonly string[];
}

export type ArknightsEnemyResolver = (
    reference: ArknightsEnemyDbRef,
) => ArknightsEnemyMovementContent;

export interface ArknightsScheduleCompilation {
    readonly schedule: Extract<SpawnScheduleDefinition, { readonly type: "WAVES" }>;
    readonly omittedActions: readonly string[];
    readonly inactiveBranches: readonly string[];
}

function actionPath(selection: ArknightsActionSelection): string {
    return `waves[${selection.waveIndex}].fragments[${selection.fragmentIndex}].actions[${selection.actionIndex}]`;
}

export function resolveActionSpawn(
    level: ArknightsLevelDefinition,
    action: ArknightsSpawnAction,
    route: RouteDefinition,
    resolveEnemy: ArknightsEnemyResolver,
): EnemySpawnDefinition {
    if (
        action.hiddenGroup !== null ||
        action.randomSpawnGroupKey !== null ||
        action.randomSpawnGroupPackKey !== null ||
        action.randomType !== "ALWAYS" ||
        action.refreshType !== "ALWAYS" ||
        action.weight !== 0 ||
        action.isUnharmfulAndAlwaysCountAsKilled
    ) {
        throw new RangeError(
            "movement schedules require unconditional spawn actions without random packs or special kill accounting",
        );
    }

    const reference = level.enemyDbRefs.find((reference) => reference.id === action.key)!;
    const content = resolveEnemy(reference);

    if (content.delayToBornTicks !== 0) {
        throw new RangeError("movement schedules require synchronous enemy births");
    }

    return {
        definition: content.definition,
        route,
        alwaysCheckCurrentPoint: content.alwaysCheckCurrentPoint,
        notCountInTotal: content.notCountInTotal,
    };
}

function compileAction(
    level: ArknightsLevelDefinition,
    action: ArknightsSpawnAction,
    preDelay: number,
    fromBranch: boolean,
    resolveEnemy: ArknightsEnemyResolver,
): SpawnActionDefinition {
    const route = (fromBranch ? level.extraRoutes : level.routes)[action.routeIndex]!;
    const spawn = resolveActionSpawn(level, action, route, resolveEnemy);
    const preDelayTicks = secondsToTicks(preDelay);

    return {
        spawn,
        offsetsTicks: Array.from({ length: action.count }, (_, index) => {
            const spawnDelay = preDelay + action.preDelay + index * action.interval;

            return secondsToTicks(spawnDelay) - preDelayTicks;
        }),
        managedByScheduler: action.managedByScheduler,
        dontBlockWave: action.dontBlockWave,
        forceBlockWaveInBranch: action.forceBlockWaveInBranch,
    };
}

export function compileSpawnSchedule(
    level: ArknightsLevelDefinition,
    selection: ArknightsScheduleSelection,
    resolveEnemy: ArknightsEnemyResolver,
): ArknightsScheduleCompilation {
    const selected = new Set<string>();

    for (const item of selection.actions) {
        for (const index of [item.waveIndex, item.fragmentIndex, item.actionIndex]) {
            if (!Number.isSafeInteger(index) || index < 0) {
                throw new RangeError("action selection indices must be nonnegative safe integers");
            }
        }

        const path = actionPath(item);
        const missingOrDuplicate =
            selected.has(path) ||
            level.waves[item.waveIndex]?.fragments[item.fragmentIndex]?.actions[
                item.actionIndex
            ] === undefined;

        if (missingOrDuplicate) {
            throw new RangeError(`action selection requires unique existing actions: ${path}`);
        }

        selected.add(path);
    }

    const selectedBranches = new Set<string>();

    for (const id of selection.branches) {
        if (selectedBranches.has(id) || !Object.hasOwn(level.branches, id)) {
            throw new RangeError(`branch selection requires a unique existing branch: ${id}`);
        }

        selectedBranches.add(id);
    }

    const omittedActions: string[] = [];
    const waves = level.waves.map((wave, waveIndex) => {
        if (wave.advancedWaveTag !== null) {
            throw new RangeError("advanced wave triggers require a content rule");
        }

        return {
            preDelayTicks: secondsToTicks(wave.preDelay),
            postDelayTicks: secondsToTicks(wave.postDelay),
            maxWaitingTicks:
                wave.maxTimeWaitingForNextWave === -1
                    ? null
                    : secondsToTicks(wave.maxTimeWaitingForNextWave),
            fragments: wave.fragments.map((fragment, fragmentIndex): FragmentDefinition => ({
                preDelayTicks: secondsToTicks(fragment.preDelay),
                actions: fragment.actions.flatMap((action, actionIndex) => {
                    const path = actionPath({ waveIndex, fragmentIndex, actionIndex });

                    if (!selected.has(path)) {
                        omittedActions.push(path);

                        return [];
                    }

                    return [compileAction(level, action, fragment.preDelay, false, resolveEnemy)];
                }),
            })),
        };
    });

    const branches: [string, BranchDefinition][] = [...selectedBranches].map((id) => [
        id,
        {
            phases: level.branches[id]!.phases.map((phase) => ({
                preDelayTicks: secondsToTicks(phase.preDelay),
                actions: phase.actions.map((action) =>
                    compileAction(level, action, phase.preDelay, true, resolveEnemy),
                ),
            })),
        },
    ]);

    return {
        schedule: { type: "WAVES", waves, branches: Object.fromEntries(branches) },
        omittedActions,
        inactiveBranches: Object.keys(level.branches).filter((id) => !selectedBranches.has(id)),
    };
}
