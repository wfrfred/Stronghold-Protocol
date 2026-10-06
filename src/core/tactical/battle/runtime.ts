import { createBattlefieldRuntime } from "../battlefield/runtime.js";
import type { BattlefieldChange, BattlefieldRemovalReason, BattlefieldRuntime } from "../battlefield/runtime.js";
import type { MechanismRuntime } from "../battlefield/mechanism.js";
import type { NavigationSpatialEffect } from "../battlefield/navigation-effect.js";
import type { NavigationOutcome } from "../navigation/state.js";
import type { NavigationMaps } from "../navigation/map.js";
import { stepRoutedUnit } from "../unit/locomotion/step.js";
import { hasRoutedLocomotion } from "../unit/locomotion/state.js";
import type { Unit, UnitId } from "../unit/unit.js";
import { createBattleSpec } from "./spec.js";
import type { BattleSpec } from "./spec.js";
import { spawnEnemies } from "./spawning.js";
import type { BattleExecutionState } from "./state.js";
import { changePredefinedInstances, predefinedIdsForAlias } from "./predefined.js";
import type { PredefinedCommand, PredefinedPresence } from "./predefined.js";
import {
    advanceSpawnSchedule, cloneScheduleState, createSpawnScheduleState, getSpawnedCount,
    getUnspawnedCount, isSpawnScheduleCompleted, recordScheduleSpawns, resolveScheduleUnits,
} from "./schedule.js";
import type { SpawnScheduleState, SpawnScheduleTrigger } from "./schedule.js";

export type BattleCommand = PredefinedCommand
    | { readonly type: "TRIGGER_BRANCH"; readonly branchId: string; readonly isLoop: boolean; };

export type BattleEvent =
    | { readonly type: "ENEMY_SPAWNED"; readonly unitId: UnitId; readonly tick: number; }
    | { readonly type: "NAVIGATION"; readonly unitId: UnitId; readonly outcome: NavigationOutcome; readonly tick: number; }
    | { readonly type: "ROUTE_COMPLETED"; readonly unitId: UnitId; readonly tick: number; }
    | { readonly type: "UNIT_REMOVED"; readonly unitId: UnitId; readonly reason: BattlefieldRemovalReason; readonly tick: number; };

export interface BattleResult {
    readonly reason: "SCHEDULE_COMPLETED" | "TIME_LIMIT";
    readonly elapsedTicks: number;
    readonly spawnedCount: number;
    readonly completedRouteCount: number;
    readonly remainingUnitIds: readonly UnitId[];
    readonly unspawnedCount: number;
}

export interface BattleSnapshot {
    readonly tickIndex: number;
    readonly spawning: SpawnScheduleState;
    readonly execution: BattleExecutionState;
    readonly predefinedPresence: readonly PredefinedPresence[];
    readonly units: readonly Unit[];
    readonly mechanisms: readonly MechanismRuntime[];
    readonly effects: readonly NavigationSpatialEffect[];
    readonly completedRouteCount: number;
    readonly result: BattleResult | null;
}

export interface BattleStep {
    readonly events: readonly BattleEvent[];
    readonly result: BattleResult | null;
}

export class BattleRuntime {
    readonly #spec: BattleSpec;
    readonly #battlefield: BattlefieldRuntime;
    #tickIndex = 0;
    #spawning: SpawnScheduleState;
    #predefinedPresence: readonly PredefinedPresence[];
    #execution: BattleExecutionState;
    #completedRouteCount = 0;
    #result: BattleResult | null = null;

    constructor(spec: BattleSpec) {
        this.#spec = createBattleSpec(spec);
        this.#spawning = createSpawnScheduleState(this.#spec.schedule);
        this.#execution = {
            rngState: this.#spec.rngState,
            nextUnitId: this.#spec.nextUnitId,
            nextNavigationRequestId: this.#spec.nextNavigationRequestId,
            nextMechanismId: this.#nextIdentityAfter(this.#spec.initialMechanisms.map(mechanism => mechanism.id)),
            nextSpatialEffectId: this.#nextIdentityAfter(this.#spec.initialEffects.map(effect => effect.id)),
        };
        this.#battlefield = createBattlefieldRuntime({ map: this.#spec.map });
        const initialized = changePredefinedInstances(
            this.#spec.predefines, [],
            this.#spec.predefines.filter(definition => definition.initiallyPresent)
                .map(definition => ({ type: "APPEAR_PREDEFINED", definitionId: definition.id })),
            this.#execution,
        );
        this.#battlefield.apply([
            ...this.#spec.initialMechanisms.map(mechanism => ({ type: "REGISTER_MECHANISM" as const, mechanism })),
            ...this.#spec.initialEffects.map(effect => ({ type: "ADD_EFFECT" as const, effect })),
            ...initialized.changes,
        ]);
        this.#execution = initialized.execution;
        this.#predefinedPresence = initialized.presence;
    }

    #nextIdentityAfter(ids: readonly number[]): number {
        const next = ids.reduce((next, id) => Math.max(next, id + 1), 0);
        if (!Number.isSafeInteger(next)) throw new RangeError("initial instance identity overflow");
        return next;
    }

    get navigationMaps(): NavigationMaps { return this.#battlefield.navigationMaps; }

    predefinedIdsForAlias(alias: string): readonly number[] {
        return predefinedIdsForAlias(this.#spec.predefines, alias);
    }

    get result(): BattleResult | null {
        return this.#result === null ? null : { ...this.#result, remainingUnitIds: [...this.#result.remainingUnitIds] };
    }

    snapshot(): BattleSnapshot {
        return {
            tickIndex: this.#tickIndex,
            spawning: cloneScheduleState(this.#spawning),
            execution: { ...this.#execution },
            predefinedPresence: this.#predefinedPresence.map(binding => ({ ...binding, source: { ...binding.source } })),
            units: this.#battlefield.unitIds.map(id => this.#battlefield.getUnit(id)!),
            mechanisms: this.#battlefield.mechanismIds.map(id => this.#battlefield.getMechanism(id)!),
            effects: this.#battlefield.effectIds.map(id => this.#battlefield.getEffect(id)!),
            completedRouteCount: this.#completedRouteCount,
            result: this.result,
        };
    }

    step(commands: readonly BattleCommand[] = []): BattleStep {
        if (this.#result !== null) return { events: [], result: this.result };
        return this.#battlefield.transact(() => this.#advance(commands));
    }

    #advance(commands: readonly BattleCommand[]): BattleStep {
        const tick = this.#tickIndex;
        const predefinedCommands: PredefinedCommand[] = [];
        const triggers: SpawnScheduleTrigger[] = [];
        for (const command of commands) {
            if (command.type === "TRIGGER_BRANCH") triggers.push(command);
            else predefinedCommands.push(command);
        }
        const predefined = changePredefinedInstances(this.#spec.predefines, this.#predefinedPresence, predefinedCommands, this.#execution);
        const scheduled = advanceSpawnSchedule(this.#spec.schedule, this.#spawning, { tick, triggers });
        const spawned = spawnEnemies(scheduled.spawns, predefined.execution);
        let spawning = recordScheduleSpawns(scheduled.state, scheduled.spawns, spawned.enemies.map(enemy => enemy.id));
        const initialized = this.#battlefield.apply([
            { type: "EXPIRE_EFFECTS", tick },
            ...predefined.changes,
            ...spawned.enemies.map(unit => ({ type: "REGISTER_UNIT" as const, unit })),
        ]);
        let execution = spawned.execution;
        let completedRouteCount = this.#completedRouteCount;
        const events: BattleEvent[] = spawned.enemies.map(enemy => ({ type: "ENEMY_SPAWNED", unitId: enemy.id, tick }));
        const changes: BattlefieldChange[] = [];
        for (const unitId of [...this.#battlefield.unitIds].sort((left, right) => left - right)) {
            const unit = this.#battlefield.getUnit(unitId)!;
            if (!hasRoutedLocomotion(unit)) continue;
            const moved = stepRoutedUnit(unit, {
                maps: this.#battlefield.navigationMaps,
                fieldCache: this.#battlefield.fieldCache,
                moveMultiplier: this.#spec.moveMultiplier,
                movementAllowed: true,
                routeAdvanceAllowed: true,
                rngState: execution.rngState,
                nextNavigationRequestId: execution.nextNavigationRequestId,
            });
            execution = { ...execution, rngState: moved.rngState, nextNavigationRequestId: moved.nextNavigationRequestId };
            for (const outcome of moved.outcomes) events.push({ type: "NAVIGATION", unitId, outcome, tick });
            if (moved.unit.locomotion.mainRoute.route.progress.phase === "COMPLETED") {
                changes.push({ type: "REMOVE_UNIT", unitId, reason: "SCRIPT" });
                events.push({ type: "ROUTE_COMPLETED", unitId, tick });
                completedRouteCount++;
            } else {
                changes.push({ type: "UPDATE_UNIT", unit: moved.unit });
            }
        }
        const committed = this.#battlefield.apply(changes);
        const removedUnits = [...initialized.removedUnits, ...committed.removedUnits];
        for (const removed of removedUnits) events.push({ type: "UNIT_REMOVED", ...removed, tick });
        spawning = resolveScheduleUnits(spawning, removedUnits.map(removed => removed.unitId));
        this.#spawning = spawning;
        this.#predefinedPresence = predefined.presence;
        this.#execution = execution;
        this.#completedRouteCount = completedRouteCount;
        this.#tickIndex++;
        const remainingUnitIds = this.#battlefield.unitIds;
        const scheduleCompleted = isSpawnScheduleCompleted(this.#spec.schedule, spawning);
        if (scheduleCompleted || this.#tickIndex >= this.#spec.maxTicks) {
            this.#result = {
                reason: scheduleCompleted ? "SCHEDULE_COMPLETED" : "TIME_LIMIT",
                elapsedTicks: this.#tickIndex,
                spawnedCount: getSpawnedCount(spawning),
                completedRouteCount,
                remainingUnitIds,
                unspawnedCount: getUnspawnedCount(this.#spec.schedule, spawning),
            };
        }
        return { events, result: this.result };
    }
}

export function simulateBattle(spec: BattleSpec): BattleResult {
    const runtime = new BattleRuntime(spec);
    while (runtime.result === null) runtime.step();
    return runtime.result;
}
