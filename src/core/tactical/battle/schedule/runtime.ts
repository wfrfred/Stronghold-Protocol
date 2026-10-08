import { createRouteTiming } from "../../unit/capability/locomotion/route/state.js";
import type { UnitId } from "../../unit/unit.js";
import { addScheduleTicks, countFragmentSpawns, type WaveDefinition } from "./definition.js";
import type {
    SpawnScheduleExecution,
    SpawnScheduleState,
    WavesScheduleExecution,
} from "./state.js";
import {
    createQueue,
    dispatchQueue,
    scheduledSpawn,
    type ScheduledScheduleSpawn,
} from "./queue.js";

export interface SpawnScheduleTrigger {
    readonly branchId: string;
    readonly isLoop: boolean;
}

export interface SpawnScheduleAdvance {
    readonly state: SpawnScheduleExecution;
    readonly spawns: readonly ScheduledScheduleSpawn[];
}

function beginWave(
    state: WavesScheduleExecution,
    wave: WaveDefinition,
    tick: number,
): WavesScheduleExecution {
    return {
        ...state,
        waveStartedAtTick: tick,
        main: { phase: "PRE_DELAY", untilTick: addScheduleTicks(tick, wave.preDelayTicks) },
    };
}

function advanceBranches(
    initial: WavesScheduleExecution,
    tick: number,
    triggers: readonly SpawnScheduleTrigger[],
    spawns: ScheduledScheduleSpawn[],
): WavesScheduleExecution {
    let state = initial;
    const { definition } = initial;
    const branchCursors = { ...state.branchCursors };
    const activeBranches = [...state.activeBranches];

    for (let index = 0; index < triggers.length; index++) {
        if (!Object.hasOwn(triggers, index)) {
            throw new TypeError("branch triggers must be dense");
        }

        const trigger = triggers[index]!;

        if (!Object.hasOwn(definition.branches, trigger.branchId)) {
            throw new RangeError(`unknown scheduler branch: ${trigger.branchId}`);
        }

        const branch = definition.branches[trigger.branchId]!;
        let cursor = branchCursors[trigger.branchId]!;

        if (cursor === branch.phases.length && trigger.isLoop && branch.phases.length > 0) {
            cursor = 0;
        }
        if (cursor === branch.phases.length) {
            continue;
        }

        const phase = branch.phases[cursor]!;
        branchCursors[trigger.branchId] = cursor + 1;
        activeBranches.push(createQueue(phase, tick, { type: "CURRENT_MAIN" }, true));
    }

    state = {
        ...state,
        branchCursors,
        activeBranches: activeBranches
            .map((queue) => dispatchQueue(queue, tick, spawns, state))
            .filter((queue) => queue.cursor < queue.spawns.length),
    };

    return state;
}

function advanceMainWaves(
    initial: WavesScheduleExecution,
    tick: number,
    spawns: ScheduledScheduleSpawn[],
): WavesScheduleExecution {
    let state = initial;
    const { definition } = initial;

    while (true) {
        if (state.main.phase === "COMPLETED") {
            return state;
        }

        const wave = definition.waves[state.waveIndex];

        if (wave === undefined) {
            return { ...state, main: { phase: "COMPLETED" } };
        }

        switch (state.main.phase) {
            case "NOT_STARTED":
                state = beginWave(state, wave, tick);
                break;

            case "PRE_DELAY":
                if (tick < state.main.untilTick) {
                    return state;
                }

                state = { ...state, main: { phase: "FRAGMENTS", fragmentIndex: 0, queue: null } };
                break;

            case "FRAGMENTS": {
                const { fragmentIndex } = state.main;
                const fragment = wave.fragments[fragmentIndex];

                if (fragment === undefined) {
                    state = { ...state, main: { phase: "WAITING", startedAtTick: tick } };
                    break;
                }

                let queue = state.main.queue;

                if (queue === null) {
                    const fragmentStartedAtTick = addScheduleTicks(tick, fragment.preDelayTicks);
                    const timing = createRouteTiming({
                        waveStartedAtTick: state.waveStartedAtTick,
                        fragmentStartedAtTick,
                    });
                    queue = createQueue(fragment, tick, { type: "FIXED", timing }, false);
                    state = { ...state, fragmentStartedAtTick };
                }

                queue = dispatchQueue(queue, tick, spawns, state);

                if (queue.cursor < queue.spawns.length) {
                    return { ...state, main: { phase: "FRAGMENTS", fragmentIndex, queue } };
                }

                state = {
                    ...state,
                    main: { phase: "FRAGMENTS", fragmentIndex: fragmentIndex + 1, queue: null },
                };
                break;
            }

            case "WAITING": {
                const waitingForWaveUnits =
                    state.managedWaveUnitIds.length > 0 ||
                    spawns.some(
                        (spawn) =>
                            spawn.schedule.managedWave &&
                            spawn.schedule.waveIndex === state.waveIndex,
                    );
                const waitingTimedOut =
                    state.waveIndex + 1 < definition.waves.length &&
                    wave.maxWaitingTicks !== null &&
                    tick - state.main.startedAtTick >= wave.maxWaitingTicks;

                if (waitingForWaveUnits && !waitingTimedOut) {
                    return state;
                }

                state = {
                    ...state,
                    managedWaveUnitIds: [],
                    main: {
                        phase: "POST_DELAY",
                        untilTick: addScheduleTicks(tick, wave.postDelayTicks),
                    },
                };
                break;
            }

            case "POST_DELAY":
                if (tick < state.main.untilTick) {
                    return state;
                }

                state = {
                    ...state,
                    waveIndex: state.waveIndex + 1,
                    main: { phase: "NOT_STARTED" },
                };
                break;
        }
    }
}

function advanceWaves(
    initial: WavesScheduleExecution,
    tick: number,
    triggers: readonly SpawnScheduleTrigger[],
    spawns: ScheduledScheduleSpawn[],
): WavesScheduleExecution {
    const { definition } = initial;
    const state =
        initial.main.phase === "NOT_STARTED" && initial.waveIndex < definition.waves.length
            ? beginWave(initial, definition.waves[initial.waveIndex]!, tick)
            : initial;
    const branched = advanceBranches(state, tick, triggers, spawns);

    return advanceMainWaves(branched, tick, spawns);
}

export function advanceSpawnSchedule(
    previous: SpawnScheduleExecution,
    context: { readonly tick: number; readonly triggers?: readonly SpawnScheduleTrigger[] },
): SpawnScheduleAdvance {
    const tick = context.tick;

    if (previous.lastTick !== null && tick < previous.lastTick) {
        throw new RangeError("schedule tick must not move backwards");
    }
    if (previous.pendingSpawnCount !== 0) {
        throw new Error("schedule spawns must be recorded before advancing");
    }

    const triggers = context.triggers ?? [];
    const spawns: ScheduledScheduleSpawn[] = [];
    let state: SpawnScheduleExecution;

    if (previous.type === "TIMELINE") {
        if (triggers.length > 0) {
            throw new RangeError("timeline schedules do not define branches");
        }

        const { definition } = previous;
        let cursor = previous.cursor;

        while (cursor < definition.spawns.length && definition.spawns[cursor]!.tick <= tick) {
            const spawn = definition.spawns[cursor]!;
            spawns.push(
                scheduledSpawn(
                    spawn,
                    spawn.tick,
                    spawn.timing,
                    !spawn.notCountInTotal,
                    false,
                    null,
                ),
            );
            cursor++;
        }

        state = { ...previous, cursor };
    } else {
        state = advanceWaves(previous, tick, triggers, spawns);
    }

    return { state: { ...state, pendingSpawnCount: spawns.length, lastTick: tick }, spawns };
}

export function recordScheduleSpawns(
    previous: SpawnScheduleExecution,
    spawns: readonly ScheduledScheduleSpawn[],
    unitIds: readonly UnitId[],
): SpawnScheduleExecution {
    if (spawns.length !== unitIds.length || spawns.length !== previous.pendingSpawnCount) {
        throw new RangeError("recorded schedule spawns must match the pending spawn batch");
    }
    if (spawns.length === 0) {
        return previous;
    }

    const newWaveUnitIds: UnitId[] = [];
    const newFinalUnitIds: UnitId[] = [];

    for (let index = 0; index < spawns.length; index++) {
        const unitId = unitIds[index]!;
        const spawn = spawns[index]!;

        if (spawn.schedule.managedFinal) {
            newFinalUnitIds.push(unitId);
        }
        if (
            spawn.schedule.managedWave &&
            previous.type === "WAVES" &&
            spawn.schedule.waveIndex === previous.waveIndex &&
            previous.main.phase !== "POST_DELAY" &&
            previous.main.phase !== "COMPLETED"
        ) {
            newWaveUnitIds.push(unitId);
        }
    }

    return {
        ...previous,
        spawnedCount: addScheduleTicks(previous.spawnedCount, spawns.length),
        pendingSpawnCount: 0,
        managedWaveUnitIds:
            newWaveUnitIds.length === 0
                ? previous.managedWaveUnitIds
                : [...previous.managedWaveUnitIds, ...newWaveUnitIds],
        managedFinalUnitIds:
            newFinalUnitIds.length === 0
                ? previous.managedFinalUnitIds
                : [...previous.managedFinalUnitIds, ...newFinalUnitIds],
    };
}

export function resolveScheduleUnits(
    previous: SpawnScheduleExecution,
    resolvedIds: readonly UnitId[],
): SpawnScheduleExecution {
    if (resolvedIds.length === 0) {
        return previous;
    }

    const resolved = new Set(resolvedIds);
    const managedWaveUnitIds = previous.managedWaveUnitIds.filter((id) => !resolved.has(id));
    const managedFinalUnitIds = previous.managedFinalUnitIds.filter((id) => !resolved.has(id));

    return {
        ...previous,
        managedWaveUnitIds:
            managedWaveUnitIds.length === previous.managedWaveUnitIds.length
                ? previous.managedWaveUnitIds
                : managedWaveUnitIds,
        managedFinalUnitIds:
            managedFinalUnitIds.length === previous.managedFinalUnitIds.length
                ? previous.managedFinalUnitIds
                : managedFinalUnitIds,
    };
}

export function isSpawnScheduleCompleted(state: SpawnScheduleExecution): boolean {
    if (state.pendingSpawnCount !== 0 || state.managedFinalUnitIds.length !== 0) {
        return false;
    }
    if (state.type === "TIMELINE") {
        return state.cursor === state.definition.spawns.length;
    }

    return state.main.phase === "COMPLETED" && state.activeBranches.length === 0;
}

export function getSpawnedCount(state: SpawnScheduleState): number {
    return state.spawnedCount;
}

export function getUnspawnedCount(state: SpawnScheduleExecution): number {
    if (state.type === "TIMELINE") {
        return addScheduleTicks(
            state.definition.spawns.length - state.cursor,
            state.pendingSpawnCount,
        );
    }

    const { waves } = state.definition;
    let count = state.pendingSpawnCount;

    for (const queue of state.activeBranches) {
        count = addScheduleTicks(count, queue.spawns.length - queue.cursor);
    }

    for (let waveIndex = state.waveIndex; waveIndex < waves.length; waveIndex++) {
        const wave = waves[waveIndex]!;

        if (
            waveIndex !== state.waveIndex ||
            state.main.phase === "NOT_STARTED" ||
            state.main.phase === "PRE_DELAY"
        ) {
            for (const fragment of wave.fragments) {
                count = addScheduleTicks(count, countFragmentSpawns(fragment));
            }
        } else if (state.main.phase === "FRAGMENTS") {
            const { fragmentIndex, queue } = state.main;

            if (queue !== null) {
                count = addScheduleTicks(count, queue.spawns.length - queue.cursor);
            }
            for (
                let index = fragmentIndex + (queue === null ? 0 : 1);
                index < wave.fragments.length;
                index++
            ) {
                count = addScheduleTicks(count, countFragmentSpawns(wave.fragments[index]!));
            }
        }
    }

    return count;
}
