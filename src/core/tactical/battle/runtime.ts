import { advanceBattlefield, battlefieldView, createBattleState } from "./execution/context.js";
import { advanceEffects, validateEffectLifetimes } from "../unit/capability/effects/lifecycle.js";
import { ActionExecutionWork } from "../unit/capability/action/internal/executions.js";
import { assert, assertNonnegativeNumber, assertPositiveSafeInteger } from "../../common/assert.js";
import { BattlefieldRuntime } from "../battlefield/runtime.js";
import type { NavigationMaps } from "../battlefield/navigation/map.js";
import { copyUnitSnapshot } from "../unit/snapshot.js";
import type { compileAction } from "../unit/capability/action/compile.js";
import {
    createActionExecutionState,
    type ActionExecutionState,
} from "../unit/capability/action/process.js";
import type { BattleExecutionState } from "./execution/state.js";
import {
    predefinedIdsForAlias,
    reconcilePredefinedPresence,
    advancePredefined,
    type PredefinedPresence,
} from "./steps/predefined.js";
import type { Input, Command, Result, Snapshot, Step } from "./contract.js";
import { finishBattleEvents } from "./events.js";
import { CombatResources } from "./resources.js";
import { createCombat } from "./steps/combat.js";
import { advanceSpawning } from "./steps/spawning.js";
import { resolveDeploymentCommands } from "./steps/deployment.js";
import { advanceMovement, advanceRouteCommands } from "./steps/movement.js";
import { advanceProjectiles } from "./steps/projectiles.js";
import { advanceElements } from "./steps/elemental.js";
import { advanceSkills } from "./steps/skills.js";
import {
    getSpawnScheduleCounts,
    isSpawnScheduleCompleted,
    resolveScheduleUnits,
} from "./schedule/runtime.js";
import { createSpawnScheduleDefinition } from "./schedule/definition.js";
import {
    snapshotSchedule,
    createSpawnScheduleExecution,
    type SpawnScheduleExecution,
} from "./schedule/state.js";
import { initializeBattlefield } from "./initialization.js";

export interface BattleResources {
    readonly combat?: CombatResources;
    readonly compileAction?: typeof compileAction;
}

export type { Input, Command, Event, Result, Snapshot, Step } from "./contract.js";

interface BattleRuntimeState {
    readonly battlefield: BattlefieldRuntime;
    readonly tickIndex: number;
    readonly schedule: SpawnScheduleExecution;
    readonly actionExecution: ActionExecutionState;
    readonly predefinedPresence: readonly PredefinedPresence[];
    readonly execution: BattleExecutionState;
    readonly completedRouteCount: number;
    readonly result: Result | null;
}

export class BattleRuntime {
    readonly #input: Input;
    readonly #combat: ReturnType<typeof createCombat>;
    readonly #combatResources: CombatResources;
    #state: BattleRuntimeState;

    constructor(input: Input, resources: BattleResources = {}) {
        assertPositiveSafeInteger(input.maxTicks, "battle tick budget");
        assertNonnegativeNumber(input.routeMoveMultiplier, "routeMoveMultiplier");
        assert(
            Number.isInteger(input.rngState) && input.rngState >= 0 && input.rngState < 2 ** 32,
            "battle RNG state must be an unsigned 32-bit integer",
            RangeError,
        );

        const predefinedIds = new Set<number>();

        for (const definition of input.predefines) {
            if (predefinedIds.has(definition.id)) {
                throw new RangeError(`duplicate predefined definition: ${definition.id}`);
            }

            predefinedIds.add(definition.id);
        }

        this.#input = input;
        this.#combatResources = (resources.combat ?? new CombatResources()).seal();
        this.#combat = createCombat(this.#combatResources, resources.compileAction);
        const scheduleDefinition = createSpawnScheduleDefinition(input.schedule);

        const battlefield = BattlefieldRuntime.create({ map: this.#input.map });
        const actionExecution = createActionExecutionState();
        const initial = createBattleState(
            battlefield,
            {
                rngState: input.rngState,
                nextUnitId: 0,
                nextNavigationRequestId: 0,
                nextMechanismId: 0,
                nextNavigationModifierId: 0,
                nextProjectileId: 0,
            },
            new ActionExecutionWork(actionExecution),
        );
        const predefinedPresence = initializeBattlefield(input, initial);
        validateEffectLifetimes(initial);
        battlefield.apply();

        this.#state = {
            battlefield,
            schedule: createSpawnScheduleExecution(scheduleDefinition),
            actionExecution,
            predefinedPresence,
            execution: initial.execution,
            tickIndex: 0,
            completedRouteCount: 0,
            result: null,
        };
    }

    get navigationMaps(): NavigationMaps {
        return this.#state.battlefield.snapshot("state").navigationMaps;
    }

    predefinedIdsForAlias(alias: string): readonly number[] {
        return predefinedIdsForAlias(this.#input.predefines, alias);
    }

    get result(): Result | null {
        return this.#state.result;
    }

    get spawnCounts(): { readonly spawnedCount: number; readonly unspawnedCount: number } {
        return getSpawnScheduleCounts(this.#state.schedule);
    }

    snapshot(): Snapshot {
        const {
            battlefield,
            tickIndex,
            schedule,
            actionExecution,
            predefinedPresence,
            execution,
            completedRouteCount,
            result,
        } = this.#state;

        const view = battlefield.snapshot("state");

        return {
            tickIndex,
            spawning: snapshotSchedule(schedule),
            predefinedPresence,
            actionExecution,
            projectiles: {
                nextProjectileId: execution.nextProjectileId,
                instances: view.projectileIds.map((id) => view.getProjectile(id)!),
            },
            execution,
            units: view.unitIds.map((id) => copyUnitSnapshot(view.getUnit(id)!)),
            blockingRelations: view.blockingRelations,
            supportRelations: view.supportRelations,
            mechanisms: view.mechanismIds.map((id) => view.getMechanism(id)!),
            navigationModifiers: view.navigationModifierIds.map((id) =>
                view.getNavigationModifier(id)!,
            ),
            completedRouteCount,
            result,
        };
    }

    step(commands: readonly Command[] = []): Step {
        if (this.#state.result !== null) {
            return { events: [], result: this.result };
        }

        const previous = this.#state;
        const battlefield = previous.battlefield;
        const tick = previous.tickIndex;
        let { schedule, predefinedPresence } = previous;
        const actionExecutions = new ActionExecutionWork(previous.actionExecution);
        const state = createBattleState(battlefield, previous.execution, actionExecutions, tick);
        const resources = this.#combatResources;

        advanceBattlefield(state, [{ type: "EXPIRE_NAVIGATION_MODIFIERS", tick }]);
        predefinedPresence = advancePredefined(
            state,
            this.#input.predefines,
            predefinedPresence,
            commands,
            tick,
            resources,
        );

        this.#combat.prepare(state, commands, tick);

        resolveDeploymentCommands(state, commands, tick, resources);

        schedule = advanceSpawning(state, schedule, commands, tick);

        advanceEffects(state, tick, resources);

        advanceElements(state, tick, resources);

        advanceSkills(state, commands, tick, resources);

        advanceRouteCommands(state, commands, tick);

        this.#combat.advance(state, tick);

        advanceProjectiles(state, tick, commands, resources);

        advanceMovement(
            state,
            tick,
            {
                routeMoveMultiplier: this.#input.routeMoveMultiplier,
                movementAllowed: (unitId) =>
                    this.#combat.allowsMovement(actionExecutions.result(), unitId),
            },
            resources,
        );

        predefinedPresence = reconcilePredefinedPresence(
            predefinedPresence,
            battlefieldView(state),
        );
        schedule = resolveScheduleUnits(
            schedule,
            state.removedUnits.map((removed) => removed.unitId),
        );
        const finishedEvents = finishBattleEvents(state.events, state.removedUnits, tick);
        const tickIndex = tick + 1;
        const completedRouteCount =
            previous.completedRouteCount + finishedEvents.completedRouteCount;
        const completed = isSpawnScheduleCompleted(schedule);
        const result: Result | null =
            completed || tickIndex >= this.#input.maxTicks
                ? {
                      reason: completed ? "SCHEDULE_COMPLETED" : "TIME_LIMIT",
                      elapsedTicks: tickIndex,
                      completedRouteCount,
                      remainingUnitIds: battlefieldView(state).unitIds,
                      ...getSpawnScheduleCounts(schedule),
                  }
                : null;

        const output: Step = { events: finishedEvents.events, result };

        const nextState: BattleRuntimeState = {
            ...previous,
            battlefield,
            tickIndex,
            completedRouteCount,
            result,
            schedule,
            actionExecution: actionExecutions.result(),
            predefinedPresence,
            execution: state.execution,
        };

        battlefield.apply();
        this.#state = nextState;

        return output;
    }
}

export function simulateBattle(input: Input): Result {
    const runtime = new BattleRuntime(input);

    while (runtime.result === null) {
        runtime.step();
    }

    return runtime.result;
}
