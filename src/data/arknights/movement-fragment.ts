import type { Seed } from "../../core/common/rng.js";
import { createBattleSpec } from "../../core/tactical/battle/spec.js";
import type { BattleSpec } from "../../core/tactical/battle/spec.js";
import type { ScheduledEnemySpawn } from "../../core/tactical/battle/spawning.js";
import { createRouteTiming } from "../../core/tactical/route/state.js";
import type { ArknightsLevelDefinition } from "./level.js";
import { resolveActionSpawn, type ArknightsEnemyResolver } from "./schedule.js";
import { secondsToTicks } from "./tick.js";

export interface ArknightsFragmentSelection {
    readonly waveIndex: number;
    readonly fragmentIndex: number;
    readonly actionIndices: readonly number[];
}

export interface ArknightsFragmentOptions {
    readonly rngState: Seed;
    readonly resolveEnemy: ArknightsEnemyResolver;
}

export interface ArknightsMovementFragment {
    readonly spec: BattleSpec;
    readonly selection: ArknightsFragmentSelection;
    readonly omittedActions: readonly string[];
    readonly inactiveBranches: readonly string[];
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
    if (wave === undefined || fragment === undefined) {
        throw new RangeError("selected fragment does not exist");
    }
    if (wave.advancedWaveTag !== null) {
        throw new RangeError("advanced wave tags require a wave scheduler");
    }
    for (const predefines of [level.predefines, level.hardPredefines]) {
        if (predefines.characterInsts.length !== 0 || predefines.tokenInsts.length !== 0) {
            throw new RangeError("predefined instances require a content initializer");
        }
    }
    if (
        !level.options.steeringEnabled ||
        level.options.functionDisableMask !== "NONE" ||
        (level.options.configBlackBoard?.length ?? 0) !== 0
    ) {
        throw new RangeError("unsupported level movement controls");
    }
    const selected = new Set<number>();
    for (const index of selection.actionIndices) {
        if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= fragment.actions.length ||
            selected.has(index)
        ) {
            throw new RangeError("action selection requires unique existing indices");
        }
        selected.add(index);
    }
    if (selected.size === 0) {
        throw new RangeError("movement fragment must select at least one action");
    }
    const fragmentStartedAtSeconds = wave.preDelay + fragment.preDelay;
    const timing = createRouteTiming({
        waveStartedAtTick: 0,
        fragmentStartedAtTick: secondsToTicks(fragmentStartedAtSeconds),
    });
    const spawns: ScheduledEnemySpawn[] = [];
    const omittedActions: string[] = [];
    for (let waveIndex = 0; waveIndex < level.waves.length; waveIndex++) {
        for (
            let fragmentIndex = 0;
            fragmentIndex < level.waves[waveIndex]!.fragments.length;
            fragmentIndex++
        ) {
            const currentFragment = level.waves[waveIndex]!.fragments[fragmentIndex]!;
            for (let actionIndex = 0; actionIndex < currentFragment.actions.length; actionIndex++) {
                const path = `waves[${waveIndex}].fragments[${fragmentIndex}].actions[${actionIndex}]`;
                if (waveIndex !== 0 || fragmentIndex !== 0 || !selected.has(actionIndex)) {
                    omittedActions.push(path);
                    continue;
                }
                const action = currentFragment.actions[actionIndex]!;
                if (
                    !action.managedByScheduler ||
                    action.blockFragment ||
                    action.dontBlockWave ||
                    action.forceBlockWaveInBranch
                ) {
                    throw new RangeError(
                        "fragment requires unconditional scheduled SPAWN actions without blocking rules",
                    );
                }
                const spawn = resolveActionSpawn(
                    level,
                    action,
                    level.routes[action.routeIndex]!,
                    options.resolveEnemy,
                );
                for (let index = 0; index < action.count; index++) {
                    spawns.push({
                        ...spawn,
                        tick: secondsToTicks(
                            fragmentStartedAtSeconds + action.preDelay + index * action.interval,
                        ),
                        timing,
                    });
                }
            }
        }
    }
    return Object.freeze({
        spec: createBattleSpec({
            map: level.map,
            schedule: { type: "TIMELINE", spawns },
            predefines: [],
            initialMechanisms: [],
            initialEffects: [],
            maxTicks: secondsToTicks(level.options.maxPlayTime),
            moveMultiplier: level.options.moveMultiplier,
            rngState: options.rngState,
            nextUnitId: 0,
            nextNavigationRequestId: 0,
        }),
        selection: Object.freeze({
            ...selection,
            actionIndices: Object.freeze([...selected].sort((left, right) => left - right)),
        }),
        omittedActions: Object.freeze(omittedActions),
        inactiveBranches: Object.freeze(Object.keys(level.branches)),
    });
}
