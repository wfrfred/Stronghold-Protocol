import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import {
    createRouteTiming,
    type RouteTiming,
} from "../../unit/capability/locomotion/route/state.js";
import type { RouteDefinition } from "../../unit/capability/locomotion/route/definition.js";
import type { EnemyDefinition } from "../../unit/archetype/enemy.js";

export interface EnemySpawnDefinition {
    readonly definition: EnemyDefinition;
    readonly route: RouteDefinition;
    readonly alwaysCheckCurrentPoint: boolean;
    readonly notCountInTotal: boolean;
}

export interface ScheduledEnemySpawn extends EnemySpawnDefinition {
    readonly tick: number;
    readonly timing: RouteTiming;
}

export interface SpawnActionDefinition {
    readonly spawn: EnemySpawnDefinition;
    readonly offsetsTicks: readonly number[];
    readonly managedByScheduler: boolean;
    readonly dontBlockWave: boolean;
    readonly forceBlockWaveInBranch: boolean;
}

export interface FragmentDefinition {
    readonly preDelayTicks: number;
    readonly actions: readonly SpawnActionDefinition[];
}

export interface WaveDefinition {
    readonly preDelayTicks: number;
    readonly postDelayTicks: number;
    readonly maxWaitingTicks: number | null;
    readonly fragments: readonly FragmentDefinition[];
}

export interface BranchDefinition {
    readonly phases: readonly FragmentDefinition[];
}

export interface TimelineScheduleDefinition {
    readonly type: "TIMELINE";
    readonly spawns: readonly ScheduledEnemySpawn[];
}

export interface WavesScheduleDefinition {
    readonly type: "WAVES";
    readonly waves: readonly WaveDefinition[];
    readonly branches: Readonly<Record<string, BranchDefinition>>;
}

export type SpawnScheduleDefinition = TimelineScheduleDefinition | WavesScheduleDefinition;

export function addScheduleTicks(left: number, right: number): number {
    const deadline = left + right;

    assertNonnegativeSafeInteger(deadline, "schedule deadline");

    return deadline;
}

function copySpawnDefinition(spawn: EnemySpawnDefinition): EnemySpawnDefinition {
    return Object.freeze({
        definition: spawn.definition,
        route: spawn.route,
        alwaysCheckCurrentPoint: spawn.alwaysCheckCurrentPoint,
        notCountInTotal: spawn.notCountInTotal,
    });
}

function copyFragment(fragment: FragmentDefinition): FragmentDefinition {
    const preDelayTicks = fragment.preDelayTicks;

    assertNonnegativeSafeInteger(preDelayTicks, "fragment.preDelayTicks");

    const actions: SpawnActionDefinition[] = [];

    for (let index = 0; index < fragment.actions.length; index++) {
        if (!Object.hasOwn(fragment.actions, index)) {
            throw new TypeError("fragment actions must be dense");
        }

        const action = fragment.actions[index]!;
        const offsetsTicks: number[] = [];

        for (const offset of action.offsetsTicks) {
            assertNonnegativeSafeInteger(offset, "spawn offset");

            offsetsTicks.push(offset);
            addScheduleTicks(preDelayTicks, offset);
        }

        actions.push(
            Object.freeze({
                spawn: copySpawnDefinition(action.spawn),
                offsetsTicks: Object.freeze(offsetsTicks),
                managedByScheduler: action.managedByScheduler,
                dontBlockWave: action.dontBlockWave,
                forceBlockWaveInBranch: action.forceBlockWaveInBranch,
            }),
        );
    }

    return Object.freeze({ preDelayTicks, actions: Object.freeze(actions) });
}

export function countFragmentSpawns(fragment: FragmentDefinition): number {
    let count = 0;

    for (const action of fragment.actions) {
        count = addScheduleTicks(count, action.offsetsTicks.length);
    }

    return count;
}

export function createSpawnScheduleDefinition(
    definition: SpawnScheduleDefinition,
): SpawnScheduleDefinition {
    if (definition.type === "TIMELINE") {
        const spawns: ScheduledEnemySpawn[] = [];

        for (let index = 0; index < definition.spawns.length; index++) {
            if (!Object.hasOwn(definition.spawns, index)) {
                throw new TypeError("timeline spawns must be dense");
            }

            const spawn = definition.spawns[index]!;

            assertNonnegativeSafeInteger(spawn.tick, "spawn.tick");

            spawns.push(
                Object.freeze({
                    ...copySpawnDefinition(spawn),
                    tick: spawn.tick,
                    timing: createRouteTiming(spawn.timing),
                }),
            );
        }

        spawns.sort((left, right) => left.tick - right.tick);

        return Object.freeze({ type: "TIMELINE", spawns: Object.freeze(spawns) });
    }

    let count = 0;
    const waves: WaveDefinition[] = [];

    for (let index = 0; index < definition.waves.length; index++) {
        if (!Object.hasOwn(definition.waves, index)) {
            throw new TypeError("waves must be dense");
        }

        const wave = definition.waves[index]!;
        const fragments: FragmentDefinition[] = [];

        for (let fragmentIndex = 0; fragmentIndex < wave.fragments.length; fragmentIndex++) {
            if (!Object.hasOwn(wave.fragments, fragmentIndex)) {
                throw new TypeError("fragments must be dense");
            }

            const copied = copyFragment(wave.fragments[fragmentIndex]!);
            count = addScheduleTicks(count, countFragmentSpawns(copied));
            fragments.push(copied);
        }

        assertNonnegativeSafeInteger(wave.preDelayTicks, "wave.preDelayTicks");
        assertNonnegativeSafeInteger(wave.postDelayTicks, "wave.postDelayTicks");

        if (wave.maxWaitingTicks !== null) {
            assertNonnegativeSafeInteger(wave.maxWaitingTicks, "wave.maxWaitingTicks");
        }

        waves.push(
            Object.freeze({
                preDelayTicks: wave.preDelayTicks,
                postDelayTicks: wave.postDelayTicks,
                maxWaitingTicks: wave.maxWaitingTicks,
                fragments: Object.freeze(fragments),
            }),
        );
    }

    const branches: [string, BranchDefinition][] = [];

    for (const [id, branch] of Object.entries(definition.branches)) {
        const phases: FragmentDefinition[] = [];

        for (let index = 0; index < branch.phases.length; index++) {
            if (!Object.hasOwn(branch.phases, index)) {
                throw new TypeError("fragments must be dense");
            }

            const copied = copyFragment(branch.phases[index]!);
            count = addScheduleTicks(count, countFragmentSpawns(copied));
            phases.push(copied);
        }

        branches.push([id, Object.freeze({ phases: Object.freeze(phases) })]);
    }

    return Object.freeze({
        type: "WAVES",
        waves: Object.freeze(waves),
        branches: Object.freeze(Object.fromEntries(branches)),
    });
}
