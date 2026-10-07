import { createRouteTiming, type RouteTiming } from "../route/state.js";
import type { RouteDefinition } from "../route/definition.js";
import type { EnemyDefinition } from "../unit/enemy.js";
import type { UnitId } from "../unit/unit.js";

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

export interface SpawnScheduleTrigger {
    readonly branchId: string;
    readonly isLoop: boolean;
}

export interface ScheduledScheduleSpawn extends ScheduledEnemySpawn {
    readonly schedule: {
        readonly managedFinal: boolean;
        readonly managedWave: boolean;
        readonly waveIndex: number | null;
    };
}

type SpawnTimingSource =
    { readonly type: "FIXED"; readonly timing: RouteTiming } | { readonly type: "CURRENT_MAIN" };

interface QueuedSpawn {
    readonly spawn: EnemySpawnDefinition;
    readonly tick: number;
    readonly timingSource: SpawnTimingSource;
    readonly managedFinal: boolean;
    readonly managedWave: boolean;
}

interface SpawnQueueState {
    readonly spawns: readonly QueuedSpawn[];
    readonly cursor: number;
}

type MainWaveProgress =
    | { readonly phase: "NOT_STARTED" }
    | { readonly phase: "PRE_DELAY"; readonly untilTick: number }
    | {
          readonly phase: "FRAGMENTS";
          readonly fragmentIndex: number;
          readonly queue: SpawnQueueState | null;
      }
    | { readonly phase: "WAITING"; readonly startedAtTick: number }
    | { readonly phase: "POST_DELAY"; readonly untilTick: number }
    | { readonly phase: "COMPLETED" };

interface ScheduleLedger {
    readonly spawnedCount: number;
    readonly pendingSpawnCount: number;
    readonly managedWaveUnitIds: readonly UnitId[];
    readonly managedFinalUnitIds: readonly UnitId[];
    readonly lastTick: number | null;
}

export interface TimelineScheduleState extends ScheduleLedger {
    readonly type: "TIMELINE";
    readonly cursor: number;
}

export interface WavesScheduleState extends ScheduleLedger {
    readonly type: "WAVES";
    readonly waveIndex: number;
    readonly waveStartedAtTick: number;
    readonly fragmentStartedAtTick: number;
    readonly main: MainWaveProgress;
    readonly branchCursors: Readonly<Record<string, number>>;
    readonly activeBranches: readonly SpawnQueueState[];
}

export type SpawnScheduleState = TimelineScheduleState | WavesScheduleState;

export interface SpawnScheduleAdvance {
    readonly state: SpawnScheduleState;
    readonly spawns: readonly ScheduledScheduleSpawn[];
}

function ticks(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }

    return value;
}

function addTicks(left: number, right: number): number {
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
            addTicks(preDelayTicks, offset);
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

function fragmentCount(fragment: FragmentDefinition): number {
    let count = 0;

    for (const action of fragment.actions) {
        count = addTicks(count, action.offsetsTicks.length);
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
            count = addTicks(count, fragmentCount(copied));
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
            count = addTicks(count, fragmentCount(copied));
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

export function createSpawnScheduleState(definition: SpawnScheduleDefinition): SpawnScheduleState {
    const ledger: ScheduleLedger = {
        spawnedCount: 0,
        pendingSpawnCount: 0,
        managedWaveUnitIds: [],
        managedFinalUnitIds: [],
        lastTick: null,
    };

    if (definition.type === "TIMELINE") {
        return { ...ledger, type: "TIMELINE", cursor: 0 };
    }

    return {
        ...ledger,
        type: "WAVES",
        waveIndex: 0,
        waveStartedAtTick: 0,
        fragmentStartedAtTick: 0,
        main: { phase: "NOT_STARTED" },
        branchCursors: Object.fromEntries(Object.keys(definition.branches).map((id) => [id, 0])),
        activeBranches: [],
    };
}

function copyQueue(queue: SpawnQueueState): SpawnQueueState {
    return { ...queue, spawns: [...queue.spawns] };
}

function copyMainWaveProgress(main: MainWaveProgress): MainWaveProgress {
    if (main.phase === "FRAGMENTS") {
        return { ...main, queue: main.queue === null ? null : copyQueue(main.queue) };
    }

    return { ...main };
}

export function cloneScheduleState(state: SpawnScheduleState): SpawnScheduleState {
    const ledger = {
        managedWaveUnitIds: [...state.managedWaveUnitIds],
        managedFinalUnitIds: [...state.managedFinalUnitIds],
    };

    if (state.type === "TIMELINE") {
        return { ...state, ...ledger };
    }

    return {
        ...state,
        ...ledger,
        main: copyMainWaveProgress(state.main),
        branchCursors: { ...state.branchCursors },
        activeBranches: state.activeBranches.map(copyQueue),
    };
}

function scheduledSpawn(
    spawn: EnemySpawnDefinition,
    tick: number,
    timing: RouteTiming,
    managedFinal: boolean,
    managedWave: boolean,
    waveIndex: number | null,
): ScheduledScheduleSpawn {
    return Object.freeze({
        ...spawn,
        tick,
        timing,
        schedule: Object.freeze({ managedFinal, managedWave, waveIndex }),
    });
}

function createQueue(
    fragment: FragmentDefinition,
    startedAtTick: number,
    timingSource: SpawnTimingSource,
    fromBranch: boolean,
): SpawnQueueState {
    const spawns: QueuedSpawn[] = [];
    const source = Object.freeze(timingSource);
    const origin = addTicks(startedAtTick, fragment.preDelayTicks);

    for (const action of fragment.actions) {
        const managedFinal = action.managedByScheduler && !action.spawn.notCountInTotal;
        const managedWave =
            managedFinal && !action.dontBlockWave && (!fromBranch || action.forceBlockWaveInBranch);

        for (const offset of action.offsetsTicks) {
            spawns.push(
                Object.freeze({
                    spawn: action.spawn,
                    tick: addTicks(origin, offset),
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

function beginWave(
    state: WavesScheduleState,
    wave: WaveDefinition,
    tick: number,
): WavesScheduleState {
    return {
        ...state,
        waveStartedAtTick: tick,
        main: { phase: "PRE_DELAY", untilTick: addTicks(tick, wave.preDelayTicks) },
    };
}

function dispatchQueue(
    queue: SpawnQueueState,
    tick: number,
    spawns: ScheduledScheduleSpawn[],
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
            scheduledSpawn(
                queued.spawn,
                queued.tick,
                timing,
                queued.managedFinal,
                queued.managedWave,
                main.waveIndex,
            ),
        );
        cursor++;
    }

    return cursor === queue.cursor ? queue : { ...queue, cursor };
}

function advanceBranches(
    definition: Extract<SpawnScheduleDefinition, { readonly type: "WAVES" }>,
    initial: WavesScheduleState,
    tick: number,
    triggers: readonly SpawnScheduleTrigger[],
    spawns: ScheduledScheduleSpawn[],
): WavesScheduleState {
    let state = initial;
    const branchCursors = { ...state.branchCursors };
    const activeBranches = [...state.activeBranches];

    for (const trigger of triggers) {
        const input: unknown = trigger;

        if (input === undefined) {
            throw new TypeError("branch triggers must be dense");
        }

        flag(trigger.isLoop, "branch trigger isLoop");

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
    definition: Extract<SpawnScheduleDefinition, { readonly type: "WAVES" }>,
    initial: WavesScheduleState,
    tick: number,
    spawns: ScheduledScheduleSpawn[],
): WavesScheduleState {
    let state = initial;

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
                    const fragmentStartedAtTick = addTicks(tick, fragment.preDelayTicks);
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
                    main: { phase: "POST_DELAY", untilTick: addTicks(tick, wave.postDelayTicks) },
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
    definition: Extract<SpawnScheduleDefinition, { readonly type: "WAVES" }>,
    initial: WavesScheduleState,
    tick: number,
    triggers: readonly SpawnScheduleTrigger[],
    spawns: ScheduledScheduleSpawn[],
): WavesScheduleState {
    const state =
        initial.main.phase === "NOT_STARTED" && initial.waveIndex < definition.waves.length
            ? beginWave(initial, definition.waves[initial.waveIndex]!, tick)
            : initial;
    const branched = advanceBranches(definition, state, tick, triggers, spawns);

    return advanceMainWaves(definition, branched, tick, spawns);
}

export function advanceSpawnSchedule(
    definition: SpawnScheduleDefinition,
    previous: SpawnScheduleState,
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
    let state: SpawnScheduleState;

    if (definition.type === "TIMELINE" && previous.type === "TIMELINE") {
        if (triggers.length > 0) {
            throw new RangeError("timeline schedules do not define branches");
        }

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
    } else if (definition.type === "WAVES" && previous.type === "WAVES") {
        state = advanceWaves(definition, previous, tick, triggers, spawns);
    } else {
        throw new TypeError("schedule state type does not match its definition");
    }

    return { state: { ...state, pendingSpawnCount: spawns.length, lastTick: tick }, spawns };
}

export function recordScheduleSpawns(
    previous: SpawnScheduleState,
    spawns: readonly ScheduledScheduleSpawn[],
    unitIds: readonly UnitId[],
): SpawnScheduleState {
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
        spawnedCount: addTicks(previous.spawnedCount, spawns.length),
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
    previous: SpawnScheduleState,
    resolvedIds: readonly UnitId[],
): SpawnScheduleState {
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

export function isSpawnScheduleCompleted(
    definition: SpawnScheduleDefinition,
    state: SpawnScheduleState,
): boolean {
    if (state.pendingSpawnCount !== 0 || state.managedFinalUnitIds.length !== 0) {
        return false;
    }
    if (state.type === "TIMELINE") {
        return (
            state.cursor ===
            (definition as Extract<SpawnScheduleDefinition, { readonly type: "TIMELINE" }>).spawns
                .length
        );
    }

    return state.main.phase === "COMPLETED" && state.activeBranches.length === 0;
}

export function getSpawnedCount(state: SpawnScheduleState): number {
    return state.spawnedCount;
}

export function getUnspawnedCount(
    definition: SpawnScheduleDefinition,
    state: SpawnScheduleState,
): number {
    if (state.type === "TIMELINE") {
        const timeline = definition as Extract<
            SpawnScheduleDefinition,
            { readonly type: "TIMELINE" }
        >;

        return addTicks(timeline.spawns.length - state.cursor, state.pendingSpawnCount);
    }

    const waves = (definition as Extract<SpawnScheduleDefinition, { readonly type: "WAVES" }>)
        .waves;
    let count = state.pendingSpawnCount;

    for (const queue of state.activeBranches) {
        count = addTicks(count, queue.spawns.length - queue.cursor);
    }

    for (let waveIndex = state.waveIndex; waveIndex < waves.length; waveIndex++) {
        const wave = waves[waveIndex]!;

        if (
            waveIndex !== state.waveIndex ||
            state.main.phase === "NOT_STARTED" ||
            state.main.phase === "PRE_DELAY"
        ) {
            for (const fragment of wave.fragments) {
                count = addTicks(count, fragmentCount(fragment));
            }
        } else if (state.main.phase === "FRAGMENTS") {
            const { fragmentIndex, queue } = state.main;

            if (queue !== null) {
                count = addTicks(count, queue.spawns.length - queue.cursor);
            }
            for (
                let index = fragmentIndex + (queue === null ? 0 : 1);
                index < wave.fragments.length;
                index++
            ) {
                count = addTicks(count, fragmentCount(wave.fragments[index]!));
            }
        }
    }

    return count;
}
