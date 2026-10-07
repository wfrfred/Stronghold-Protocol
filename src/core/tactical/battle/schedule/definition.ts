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

export type SpawnScheduleDefinition =
    | { readonly type: "TIMELINE"; readonly spawns: readonly ScheduledEnemySpawn[] }
    | {
          readonly type: "WAVES";
          readonly waves: readonly WaveDefinition[];
          readonly branches: Readonly<Record<string, BranchDefinition>>;
      };

function ticks(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }

    return value;
}

export function addScheduleTicks(left: number, right: number): number {
    return ticks(left + right, "schedule deadline");
}

function flag(value: boolean, name: string): boolean {
    if (typeof value !== "boolean") {
        throw new TypeError(`${name} must be boolean`);
    }

    return value;
}

function copySpawnDefinition(spawn: EnemySpawnDefinition): EnemySpawnDefinition {
    const input: unknown = spawn;

    if (input === undefined) {
        throw new TypeError("spawn definitions must be dense");
    }

    flag(spawn.alwaysCheckCurrentPoint, "alwaysCheckCurrentPoint");
    flag(spawn.notCountInTotal, "notCountInTotal");

    return Object.freeze({
        definition: spawn.definition,
        route: spawn.route,
        alwaysCheckCurrentPoint: spawn.alwaysCheckCurrentPoint,
        notCountInTotal: spawn.notCountInTotal,
    });
}

function copyFragment(fragment: FragmentDefinition): FragmentDefinition {
    const input: unknown = fragment;

    if (input === undefined) {
        throw new TypeError("fragments must be dense");
    }

    const preDelayTicks = ticks(fragment.preDelayTicks, "fragment.preDelayTicks");
    const actions: SpawnActionDefinition[] = [];

    for (const action of fragment.actions) {
        const input: unknown = action;

        if (input === undefined) {
            throw new TypeError("fragment actions must be dense");
        }

        const offsetsTicks: number[] = [];

        for (const offset of action.offsetsTicks) {
            offsetsTicks.push(ticks(offset, "spawn offset"));
            addScheduleTicks(preDelayTicks, offset);
        }

        actions.push(
            Object.freeze({
                spawn: copySpawnDefinition(action.spawn),
                offsetsTicks: Object.freeze(offsetsTicks),
                managedByScheduler: flag(action.managedByScheduler, "managedByScheduler"),
                dontBlockWave: flag(action.dontBlockWave, "dontBlockWave"),
                forceBlockWaveInBranch: flag(
                    action.forceBlockWaveInBranch,
                    "forceBlockWaveInBranch",
                ),
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

        for (const spawn of definition.spawns) {
            const input: unknown = spawn;

            if (input === undefined) {
                throw new TypeError("timeline spawns must be dense");
            }

            spawns.push(
                Object.freeze({
                    ...copySpawnDefinition(spawn),
                    tick: ticks(spawn.tick, "spawn.tick"),
                    timing: createRouteTiming(spawn.timing),
                }),
            );
        }

        spawns.sort((left, right) => left.tick - right.tick);

        return Object.freeze({ type: "TIMELINE", spawns: Object.freeze(spawns) });
    }

    const type: unknown = definition.type;

    if (type !== "WAVES") {
        throw new RangeError("unsupported spawn schedule type");
    }

    let count = 0;
    const waves: WaveDefinition[] = [];

    for (const wave of definition.waves) {
        const input: unknown = wave;

        if (input === undefined) {
            throw new TypeError("waves must be dense");
        }

        const fragments: FragmentDefinition[] = [];

        for (const fragment of wave.fragments) {
            const copied = copyFragment(fragment);
            count = addScheduleTicks(count, countFragmentSpawns(copied));
            fragments.push(copied);
        }

        waves.push(
            Object.freeze({
                preDelayTicks: ticks(wave.preDelayTicks, "wave.preDelayTicks"),
                postDelayTicks: ticks(wave.postDelayTicks, "wave.postDelayTicks"),
                maxWaitingTicks:
                    wave.maxWaitingTicks === null
                        ? null
                        : ticks(wave.maxWaitingTicks, "wave.maxWaitingTicks"),
                fragments: Object.freeze(fragments),
            }),
        );
    }

    const branches: [string, BranchDefinition][] = [];

    for (const [id, branch] of Object.entries(definition.branches)) {
        const input: unknown = branch;

        if (input === undefined) {
            throw new TypeError("branch definitions must be present");
        }

        const phases: FragmentDefinition[] = [];

        for (const phase of branch.phases) {
            const copied = copyFragment(phase);
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
