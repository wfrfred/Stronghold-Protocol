import { advanceBattlefield, battlefieldView, createBattleState, type State } from "./state.js";
import { advance as advanceEffects, validateScopes } from "../unit/effect/operations.js";
import { assert, assertNonnegativeNumber, assertPositiveSafeInteger } from "../../common/assert.js";
import { create as createBattlefield } from "../battlefield/state.js";
import { view as createBattlefieldView } from "../battlefield/view.js";
import type { NavigationMaps } from "../battlefield/navigation/map.js";
import { copy } from "../unit/snapshot.js";
import type { compileAction } from "../unit/capability/action/compile.js";
import { createActionExecutionState } from "../unit/capability/action/process.js";
import {
    predefinedIdsForAlias,
    reconcilePredefinedPresence,
    advancePredefined,
} from "./steps/predefined.js";
import type { Input, Command, Result, Snapshot, Step } from "./contract.js";
import { CombatResources } from "./resources.js";
import { createCombat } from "./steps/combat.js";
import { advanceSpawning } from "./steps/spawning.js";
import { resolveDeploymentCommands } from "./deployment/operations.js";
import { advanceMovement, advanceRouteCommands } from "./steps/movement.js";
import { advanceProjectiles } from "./steps/projectiles.js";
import { advanceElements } from "./steps/elemental.js";
import { advanceSkills } from "./steps/skills.js";
import { finishBattleEvents } from "./events.js";
import {
    getSpawnScheduleCounts,
    isSpawnScheduleCompleted,
    resolveScheduleUnits,
} from "./schedule/runtime.js";
import { createSpawnScheduleDefinition } from "./schedule/definition.js";
import { snapshotSchedule, createSpawnScheduleExecution } from "./schedule/state.js";
import { initializeBattlefield } from "./initialization.js";
import { advanceUnits } from "./execution/unit-lifecycle.js";
import {
    addCard,
    advance as advanceDeployment,
    initialize as initializeDeployment,
} from "./deployment/deployment.js";

export interface BattleResources {
    readonly combat?: CombatResources;
    readonly compileAction?: typeof compileAction;
}

export type { Input, Command, Event, Result, Snapshot, Step } from "./contract.js";

export class BattleRuntime {
    readonly #input: Input;
    readonly #combat: ReturnType<typeof createCombat>;
    readonly #combatResources: CombatResources;
    #state: State;

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

        const battlefield = createBattlefield({ map: this.#input.map });
        const actionExecution = createActionExecutionState();
        let initial = createBattleState(
            battlefield,
            {
                rngState: input.rngState,
                nextCardId: 0,
                nextUnitId: 0,
                nextNavigationRequestId: 0,
                nextMechanismId: 0,
                nextNavigationModifierId: 0,
                nextProjectileId: 0,
            },
            actionExecution,
            0,
            initializeDeployment(input.deployment?.definition),
            createSpawnScheduleExecution(scheduleDefinition),
        );

        for (const definition of input.deployment?.cards ?? []) {
            initial = addCard(initial, definition).state;
        }

        const initialized = initializeBattlefield(input, initial);
        validateScopes(initialized);
        this.#state = initialized;
    }

    get navigationMaps(): NavigationMaps {
        return this.#state.battlefield.navigationMaps;
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
            tick: tickIndex,
            schedule,
            actionExecutions: actionExecution,
            deployment,
            predefinedPresence,
            execution,
            completedRouteCount,
            result,
        } = this.#state;

        const view = createBattlefieldView(battlefield);

        return {
            deployment,
            tickIndex,
            spawning: snapshotSchedule(schedule),
            predefinedPresence,
            actionExecution,
            projectiles: {
                nextProjectileId: execution.nextProjectileId,
                instances: view.projectileIds.map((id) => view.getProjectile(id)!),
            },
            execution,
            units: view.unitIds.map((id) => copy(view.getUnit(id)!)),
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

        const tick = this.#state.tick;
        const resources = this.#combatResources;
        let state: State = {
            ...this.#state,
            events: [],
            removedUnits: [],
            closedLifetimes: new Set(),
        };

        state = advanceBattlefield(state, [{ type: "EXPIRE_NAVIGATION_MODIFIERS", tick }]);
        state = advanceDeployment(state, tick);
        state = advancePredefined(state, this.#input.predefines, commands, tick, resources);

        state = this.#combat.prepare(state, commands, tick);

        state = resolveDeploymentCommands(state, commands, resources);

        state = advanceSpawning(state, commands, tick);

        state = advanceUnits(state);

        state = advanceEffects(state);

        state = advanceElements(state, tick, resources);

        state = advanceSkills(state, commands, tick, resources);

        state = advanceRouteCommands(state, commands, tick);

        state = this.#combat.advance(state, tick);

        state = advanceProjectiles(state, tick, commands, resources);

        state = advanceMovement(
            state,
            tick,
            {
                routeMoveMultiplier: this.#input.routeMoveMultiplier,
                movementAllowed: (unitId) =>
                    this.#combat.allowsMovement(state.actionExecutions, unitId),
            },
            resources,
        );

        state = {
            ...state,
            predefinedPresence: reconcilePredefinedPresence(
                state.predefinedPresence,
                battlefieldView(state),
            ),
            schedule: resolveScheduleUnits(
                state.schedule,
                state.removedUnits.map((removed) => removed.unitId),
            ),
        };
        const finishedEvents = finishBattleEvents(state.events, state.removedUnits, tick);
        const tickIndex = tick + 1;
        const completedRouteCount = state.completedRouteCount + finishedEvents.completedRouteCount;
        const completed = isSpawnScheduleCompleted(state.schedule);
        const result: Result | null =
            completed || tickIndex >= this.#input.maxTicks
                ? {
                      reason: completed ? "SCHEDULE_COMPLETED" : "TIME_LIMIT",
                      elapsedTicks: tickIndex,
                      completedRouteCount,
                      remainingUnitIds: battlefieldView(state).unitIds,
                      ...getSpawnScheduleCounts(state.schedule),
                  }
                : null;

        state = {
            ...state,
            tick: tickIndex,
            completedRouteCount,
            result,
            events: finishedEvents.events,
        };
        this.#state = state;

        return { events: finishedEvents.events, result };
    }
}

export function simulateBattle(input: Input): Result {
    const runtime = new BattleRuntime(input);

    while (runtime.result === null) {
        runtime.step();
    }

    return runtime.result;
}
