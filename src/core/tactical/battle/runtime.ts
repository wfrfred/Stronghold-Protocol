import { createBattlefieldRuntime } from "../battlefield/runtime.js";
import type { BattlefieldChange, BattlefieldRemovalReason, BattlefieldRuntime } from "../battlefield/runtime.js";
import type { MechanismRuntime } from "../battlefield/mechanism.js";
import type { NavigationSpatialEffect } from "../battlefield/navigation-effect.js";
import type { NavigationOutcome } from "../navigation/state.js";
import { copyRoutedEnemy, stepRoutedEnemy } from "../unit/enemy.js";
import type { RoutedEnemy } from "../unit/enemy.js";
import type { UnitId } from "../unit/unit.js";
import { createBattleSpec } from "./spec.js";
import type { BattleSpec } from "./spec.js";
import { spawnDueEnemies } from "./spawning.js";
import type { SpawnProgress } from "./spawning.js";
import type { BattleExecutionState } from "./state.js";

export type BattleEvent =
    | { readonly type: "ENEMY_SPAWNED"; readonly unitId: UnitId; readonly tick: number; }
    | { readonly type: "NAVIGATION"; readonly unitId: UnitId; readonly outcome: NavigationOutcome; readonly tick: number; }
    | { readonly type: "ROUTE_COMPLETED"; readonly unitId: UnitId; readonly tick: number; }
    | { readonly type: "UNIT_REMOVED"; readonly unitId: UnitId; readonly reason: BattlefieldRemovalReason; readonly tick: number; };

export interface BattleResult {
    readonly reason: "ROUTES_COMPLETED" | "TIME_LIMIT";
    readonly elapsedTicks: number;
    readonly spawnedCount: number;
    readonly completedRouteCount: number;
    readonly remainingUnitIds: readonly UnitId[];
    readonly unspawnedCount: number;
}

export interface BattleSnapshot {
    readonly tickIndex: number;
    readonly spawning: SpawnProgress;
    readonly execution: BattleExecutionState;
    readonly units: readonly RoutedEnemy[];
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
    readonly #battlefield: BattlefieldRuntime<RoutedEnemy>;
    #tickIndex = 0;
    #spawning: SpawnProgress = { cursor: 0 };
    #execution: BattleExecutionState;
    #completedRouteCount = 0;
    #result: BattleResult | null = null;

    constructor(spec: BattleSpec) {
        this.#spec = createBattleSpec(spec);
        this.#execution = {
            rngState: this.#spec.rngState,
            nextUnitId: this.#spec.nextUnitId,
            nextNavigationRequestId: this.#spec.nextNavigationRequestId,
        };
        this.#battlefield = createBattlefieldRuntime<RoutedEnemy>(
            { map: this.#spec.map },
            copyRoutedEnemy,
        );
        this.#battlefield.apply([
            ...this.#spec.initialMechanisms.map(mechanism => ({ type: "REGISTER_MECHANISM" as const, mechanism })),
            ...this.#spec.initialEffects.map(effect => ({ type: "ADD_EFFECT" as const, effect })),
        ]);
    }

    get result(): BattleResult | null {
        return this.#result === null ? null : { ...this.#result, remainingUnitIds: [...this.#result.remainingUnitIds] };
    }

    snapshot(): BattleSnapshot {
        return {
            tickIndex: this.#tickIndex,
            spawning: { ...this.#spawning },
            execution: { ...this.#execution },
            units: this.#battlefield.unitIds.map(id => this.#battlefield.getUnit(id)!),
            mechanisms: this.#battlefield.mechanismIds.map(id => this.#battlefield.getMechanism(id)!),
            effects: this.#battlefield.effectIds.map(id => this.#battlefield.getEffect(id)!),
            completedRouteCount: this.#completedRouteCount,
            result: this.result,
        };
    }

    step(): BattleStep {
        if (this.#result !== null) return { events: [], result: this.result };
        return this.#battlefield.transact(() => this.#advance());
    }

    #advance(): BattleStep {
        const tick = this.#tickIndex;
        const spawned = spawnDueEnemies(this.#spec.spawns, this.#spawning, this.#execution, tick);
        this.#battlefield.apply([
            { type: "EXPIRE_EFFECTS", tick },
            ...spawned.enemies.map(unit => ({ type: "REGISTER_UNIT" as const, unit })),
        ]);
        let execution = spawned.execution;
        let completedRouteCount = this.#completedRouteCount;
        const events: BattleEvent[] = spawned.enemies.map(enemy => ({ type: "ENEMY_SPAWNED", unitId: enemy.id, tick }));
        const changes: BattlefieldChange<RoutedEnemy>[] = [];
        for (const unitId of [...this.#battlefield.unitIds].sort((left, right) => left - right)) {
            const moved = stepRoutedEnemy(this.#battlefield.getUnit(unitId)!, {
                maps: this.#battlefield.navigationMaps,
                fieldCache: this.#battlefield.fieldCache,
                moveMultiplier: this.#spec.moveMultiplier,
                steeringParameters: this.#spec.steeringParameters,
                movementAllowed: true,
                routeAdvanceAllowed: true,
                rngState: execution.rngState,
                nextNavigationRequestId: execution.nextNavigationRequestId,
            });
            execution = { ...execution, rngState: moved.rngState, nextNavigationRequestId: moved.nextNavigationRequestId };
            for (const outcome of moved.outcomes) events.push({ type: "NAVIGATION", unitId, outcome, tick });
            if (moved.enemy.locomotion.mainRoute.route.progress.phase === "COMPLETED") {
                changes.push({ type: "REMOVE_UNIT", unitId, reason: "SCRIPT" });
                events.push({ type: "ROUTE_COMPLETED", unitId, tick });
                completedRouteCount++;
            } else {
                changes.push({ type: "UPDATE_UNIT", unit: moved.enemy });
            }
        }
        const committed = this.#battlefield.apply(changes);
        for (const removed of committed.removedUnits) events.push({ type: "UNIT_REMOVED", ...removed, tick });
        this.#spawning = spawned.progress;
        this.#execution = execution;
        this.#completedRouteCount = completedRouteCount;
        this.#tickIndex++;
        const remainingUnitIds = this.#battlefield.unitIds;
        const routesCompleted = spawned.progress.cursor === this.#spec.spawns.length && remainingUnitIds.length === 0;
        if (routesCompleted || this.#tickIndex >= this.#spec.maxTicks) {
            this.#result = {
                reason: routesCompleted ? "ROUTES_COMPLETED" : "TIME_LIMIT",
                elapsedTicks: this.#tickIndex,
                spawnedCount: spawned.progress.cursor,
                completedRouteCount,
                remainingUnitIds,
                unspawnedCount: this.#spec.spawns.length - spawned.progress.cursor,
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
