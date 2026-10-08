import {
    createRouteTiming,
    type RouteTiming,
} from "../../unit/capability/locomotion/route/state.js";
import {
    addScheduleTicks,
    type EnemySpawnDefinition,
    type FragmentDefinition,
    type ScheduledEnemySpawn,
} from "./definition.js";
import type {
    QueuedSpawn,
    SpawnQueueState,
    SpawnTimingSource,
    WavesScheduleState,
} from "./state.js";

export interface ScheduleSpawn extends ScheduledEnemySpawn {
    readonly schedule: {
        readonly managedFinal: boolean;
        readonly managedWave: boolean;
        readonly waveIndex: number | null;
    };
}

export function createScheduleSpawn({
    spawn,
    tick,
    timing,
    management,
}: {
    readonly spawn: EnemySpawnDefinition;
    readonly tick: number;
    readonly timing: RouteTiming;
    readonly management: ScheduleSpawn["schedule"];
}): ScheduleSpawn {
    return Object.freeze({
        ...spawn,
        tick,
        timing,
        schedule: Object.freeze({ ...management }),
    });
}

export function createQueue(
    fragment: FragmentDefinition,
    startedAtTick: number,
    timingSource: SpawnTimingSource,
    fromBranch: boolean,
): SpawnQueueState {
    const spawns: QueuedSpawn[] = [];
    const source = Object.freeze(timingSource);
    const origin = addScheduleTicks(startedAtTick, fragment.preDelayTicks);

    for (const action of fragment.actions) {
        const managedFinal = action.managedByScheduler && !action.spawn.notCountInTotal;
        const managedWave =
            managedFinal && !action.dontBlockWave && (!fromBranch || action.forceBlockWaveInBranch);

        for (const offset of action.offsetsTicks) {
            spawns.push(
                Object.freeze({
                    spawn: action.spawn,
                    tick: addScheduleTicks(origin, offset),
                    timingSource: source,
                    managedFinal,
                    managedWave,
                }),
            );
        }
    }

    spawns.sort((left, right) => left.tick - right.tick);

    return { spawns, cursor: 0 };
}

export function dispatchQueue(
    queue: SpawnQueueState,
    tick: number,
    spawns: ScheduleSpawn[],
    main: WavesScheduleState,
): SpawnQueueState {
    let cursor = queue.cursor;

    while (cursor < queue.spawns.length && queue.spawns[cursor]!.tick <= tick) {
        const queued = queue.spawns[cursor]!;
        const timing =
            queued.timingSource.type === "FIXED"
                ? queued.timingSource.timing
                : createRouteTiming({
                      waveStartedAtTick: main.waveStartedAtTick,
                      fragmentStartedAtTick: main.fragmentStartedAtTick,
                  });

        spawns.push(
            createScheduleSpawn({
                spawn: queued.spawn,
                tick: queued.tick,
                timing,
                management: {
                    managedFinal: queued.managedFinal,
                    managedWave: queued.managedWave,
                    waveIndex: main.waveIndex,
                },
            }),
        );
        cursor++;
    }

    return cursor === queue.cursor ? queue : { ...queue, cursor };
}
