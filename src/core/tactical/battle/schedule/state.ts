import type { RouteTiming } from "../../unit/capability/locomotion/route/state.js";
import type { UnitId } from "../../unit/unit.js";
import type {
    EnemySpawnDefinition,
    SpawnScheduleDefinition,
    TimelineScheduleDefinition,
    WavesScheduleDefinition,
} from "./definition.js";

export type SpawnTimingSource =
    { readonly type: "FIXED"; readonly timing: RouteTiming } | { readonly type: "CURRENT_MAIN" };

export interface QueuedSpawn {
    readonly spawn: EnemySpawnDefinition;
    readonly tick: number;
    readonly timingSource: SpawnTimingSource;
    readonly managedFinal: boolean;
    readonly managedWave: boolean;
}

export interface SpawnQueueState {
    readonly spawns: readonly QueuedSpawn[];
    readonly cursor: number;
}

export type MainWaveProgress =
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

export interface ScheduleLedger {
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

export interface TimelineScheduleExecution extends TimelineScheduleState {
    readonly definition: TimelineScheduleDefinition;
}

export interface WavesScheduleExecution extends WavesScheduleState {
    readonly definition: WavesScheduleDefinition;
}

export type SpawnScheduleExecution = TimelineScheduleExecution | WavesScheduleExecution;

export function createSpawnScheduleExecution(
    definition: SpawnScheduleDefinition,
): SpawnScheduleExecution {
    const ledger: ScheduleLedger = {
        spawnedCount: 0,
        pendingSpawnCount: 0,
        managedWaveUnitIds: [],
        managedFinalUnitIds: [],
        lastTick: null,
    };

    if (definition.type === "TIMELINE") {
        return { ...ledger, type: "TIMELINE", definition, cursor: 0 };
    }

    return {
        ...ledger,
        type: "WAVES",
        definition,
        waveIndex: 0,
        waveStartedAtTick: 0,
        fragmentStartedAtTick: 0,
        main: { phase: "NOT_STARTED" },
        branchCursors: Object.fromEntries(Object.keys(definition.branches).map((id) => [id, 0])),
        activeBranches: [],
    };
}

export function snapshotSchedule(state: SpawnScheduleState): SpawnScheduleState {
    const ledger: ScheduleLedger = {
        spawnedCount: state.spawnedCount,
        pendingSpawnCount: state.pendingSpawnCount,
        managedWaveUnitIds: state.managedWaveUnitIds,
        managedFinalUnitIds: state.managedFinalUnitIds,
        lastTick: state.lastTick,
    };

    if (state.type === "TIMELINE") {
        return { ...ledger, type: "TIMELINE", cursor: state.cursor };
    }

    return {
        ...ledger,
        type: "WAVES",
        waveIndex: state.waveIndex,
        waveStartedAtTick: state.waveStartedAtTick,
        fragmentStartedAtTick: state.fragmentStartedAtTick,
        main: state.main,
        branchCursors: state.branchCursors,
        activeBranches: state.activeBranches,
    };
}
