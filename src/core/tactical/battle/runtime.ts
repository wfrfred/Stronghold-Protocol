import { advanceBattlefield, battlefieldView, createBattleState } from "./state.js";
import { advance as advanceEffects, validateScopes } from "../unit/effect/operations.js";
import { assert, assertNonnegativeNumber, assertPositiveSafeInteger } from "../../common/assert.js";
import {
    create as createBattlefield,
    type State as BattlefieldState,
} from "../battlefield/state.js";
import { view as createBattlefieldView } from "../battlefield/view.js";
import type { NavigationMaps } from "../battlefield/navigation/map.js";
import { copy } from "../unit/snapshot.js";
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
import { CombatResources } from "./resources.js";
import { createCombat } from "./steps/combat.js";
import { advanceSpawning } from "./steps/spawning.js";
import { resolveDeploymentCommands } from "./steps/deployment.js";
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
import {
    snapshotSchedule,
    createSpawnScheduleExecution,
    type SpawnScheduleExecution,
} from "./schedule/state.js";
import { initializeBattlefield } from "./initialization.js";
import type { State as DeploymentState } from "./deployment/deployment.js";

interface State {
    readonly battlefield: BattlefieldState;
    readonly tick: number;
    readonly schedule: SpawnScheduleExecution;
    readonly actionExecutions: ActionExecutionState;
    readonly deployment: DeploymentState;
    readonly predefinedPresence: readonly PredefinedPresence[];
    readonly execution: BattleExecutionState;
    readonly completedRouteCount: number;
    readonly result: Result | null;
}

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
            actionExecution,
        );
        const initialized = initializeBattlefield(input, initial);
        validateScopes(initialized.state);

        this.#state = {
            battlefield: initialized.state.battlefield,
            schedule: createSpawnScheduleExecution(scheduleDefinition),
            actionExecutions: initialized.state.actionExecutions,
            deployment: initialized.state.deployment,
            predefinedPresence: initialized.value,
            execution: initialized.state.execution,
            tick: 0,
            completedRouteCount: 0,
            result: null,
        };
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

        const previous = this.#state;
        const tick = previous.tick;
        const resources = this.#combatResources;
        let { schedule, predefinedPresence } = previous;
        let state = createBattleState(
            previous.battlefield,
            previous.execution,
            previous.actionExecutions,
            tick,
            previous.deployment,
        );

        state = advanceBattlefield(state, [{ type: "EXPIRE_NAVIGATION_MODIFIERS", tick }]);
        const predefined = advancePredefined(
            state,
            this.#input.predefines,
            predefinedPresence,
            commands,
            tick,
            resources,
        );
        state = predefined.state;
        predefinedPresence = predefined.value;

        state = this.#combat.prepare(state, commands, tick);

        state = resolveDeploymentCommands(state, commands, tick, resources);

        const spawned = advanceSpawning(state, schedule, commands, tick);
        state = spawned.state;
        schedule = spawned.value;

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

        this.#state = {
            battlefield: state.battlefield,
            tick: tickIndex,
            completedRouteCount,
            result,
            schedule,
            actionExecutions: state.actionExecutions,
            deployment: state.deployment,
            predefinedPresence,
            execution: state.execution,
        };

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
