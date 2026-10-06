import type { Seed } from "../../core/common/rng.js";
import { createBattleSpec } from "../../core/tactical/battle/spec.js";
import type { BattleSpec, ScheduledEnemySpawn } from "../../core/tactical/battle/spec.js";
import { createRouteTiming } from "../../core/tactical/route/state.js";
import type { EnemyDefinition } from "../../core/tactical/unit/enemy.js";
import { createSteeringParameters } from "../../core/tactical/unit/locomotion/steering.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";
import { perSecondToPerTick, secondsToTicks } from "./tick.js";
import type { ArknightsEnemyDbRef, ArknightsLevelDefinition, ArknightsSpawnAction } from "./level.js";

export interface ArknightsFragmentSelection {
    readonly waveIndex: number;
    readonly fragmentIndex: number;
    readonly actionIndices: readonly number[];
}

export interface ArknightsSteeringParameters {
    readonly steeringFactorPerSecond: number;
    readonly maxSteeringForcePerSecondSquared: number;
}

export interface ArknightsFragmentOptions {
    readonly steeringParameters: ArknightsSteeringParameters;
    readonly alwaysCheckCurrentPoint: boolean;
    readonly rngState: Seed;
    readonly resolveEnemy: (reference: ArknightsEnemyDbRef) => EnemyDefinition;
}

export interface ArknightsMovementFragment {
    readonly spec: BattleSpec;
    readonly selection: ArknightsFragmentSelection;
    readonly omittedActions: readonly string[];
    readonly inactiveBranches: readonly string[];
}

function requireScheduledAction(action: ArknightsSpawnAction): void {
    if (!action.managedByScheduler || action.blockFragment || action.dontBlockWave || action.forceBlockWaveInBranch
        || action.isUnharmfulAndAlwaysCountAsKilled || action.hiddenGroup !== null
        || action.randomSpawnGroupKey !== null || action.randomSpawnGroupPackKey !== null
        || action.randomType !== "ALWAYS" || action.refreshType !== "ALWAYS" || action.weight !== 0) {
        throw new RangeError("fragment requires unconditional scheduled SPAWN actions without blocking rules");
    }
}

export function compileLevelMovementFragment(
    level: ArknightsLevelDefinition,
    selection: ArknightsFragmentSelection,
    options: ArknightsFragmentOptions,
): ArknightsMovementFragment {
    if (selection.waveIndex !== 0 || selection.fragmentIndex !== 0) {
        throw new RangeError("later wave and fragment start times require a wave scheduler");
    }
    const wave = level.waves[0];
    const fragment = wave?.fragments[0];
    if (wave === undefined || fragment === undefined) throw new RangeError("selected fragment does not exist");
    if (wave.advancedWaveTag !== null) throw new RangeError("advanced wave tags require a wave scheduler");
    for (const predefines of [level.predefines, level.hardPredefines]) {
        if (predefines.characterInsts.length !== 0 || predefines.tokenInsts.length !== 0) {
            throw new RangeError("predefined instances require a content initializer");
        }
    }
    if (!level.options.steeringEnabled || level.options.functionDisableMask !== "NONE"
        || (level.options.configBlackBoard?.length ?? 0) !== 0) {
        throw new RangeError("unsupported level movement controls");
    }
    const selected = new Set<number>();
    for (const index of selection.actionIndices) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= fragment.actions.length || selected.has(index)) {
            throw new RangeError("action selection requires unique existing indices");
        }
        selected.add(index);
    }
    if (selected.size === 0) throw new RangeError("movement fragment must select at least one action");
    const fragmentStartedAtSeconds = wave.preDelay + fragment.preDelay;
    const timing = createRouteTiming({ waveStartedAtTick: 0, fragmentStartedAtTick: secondsToTicks(fragmentStartedAtSeconds) });
    const spawns: ScheduledEnemySpawn[] = [];
    const omittedActions: string[] = [];
    for (let waveIndex = 0; waveIndex < level.waves.length; waveIndex++) {
        const currentWave = level.waves[waveIndex]!;
        for (let fragmentIndex = 0; fragmentIndex < currentWave.fragments.length; fragmentIndex++) {
            const currentFragment = currentWave.fragments[fragmentIndex]!;
            for (let actionIndex = 0; actionIndex < currentFragment.actions.length; actionIndex++) {
                const path = `waves[${waveIndex}].fragments[${fragmentIndex}].actions[${actionIndex}]`;
                if (waveIndex !== 0 || fragmentIndex !== 0 || !selected.has(actionIndex)) {
                    omittedActions.push(path);
                    continue;
                }
                const action = currentFragment.actions[actionIndex]!;
                requireScheduledAction(action);
                const reference = level.enemyDbRefs.find(reference => reference.id === action.key)!;
                if (reference.overwrittenData !== null) throw new RangeError(`${path} requires enemy override resolution`);
                const definition = options.resolveEnemy(reference);
                if (definition.id !== action.key) throw new RangeError(`${path} enemy definition does not match its reference`);
                for (let index = 0; index < action.count; index++) {
                    spawns.push({
                        tick: secondsToTicks(fragmentStartedAtSeconds + action.preDelay + index * action.interval),
                        definition,
                        route: level.routes[action.routeIndex]!,
                        timing,
                        alwaysCheckCurrentPoint: options.alwaysCheckCurrentPoint,
                    });
                }
            }
        }
    }
    return Object.freeze({
        spec: createBattleSpec({
            map: level.map,
            spawns,
            initialMechanisms: [],
            initialEffects: [],
            maxTicks: secondsToTicks(level.options.maxPlayTime),
            moveMultiplier: level.options.moveMultiplier,
            steeringParameters: createSteeringParameters({
                steeringFactor: perSecondToPerTick(options.steeringParameters.steeringFactorPerSecond),
                maxSteeringForce: options.steeringParameters.maxSteeringForcePerSecondSquared / TICKS_PER_SECOND ** 2,
            }),
            rngState: options.rngState,
            nextUnitId: 0,
            nextNavigationRequestId: 0,
        }),
        selection: Object.freeze({ ...selection, actionIndices: Object.freeze([...selected].sort((left, right) => left - right)) }),
        omittedActions: Object.freeze(omittedActions),
        inactiveBranches: Object.freeze(Object.keys(level.branches)),
    });
}
