import { advanceBattlefield, battlefieldView, createBattleState } from "./execution/context.js";
import { validateEffectLifetimes } from "../unit/capability/effects/lifecycle.js";
import { ActionExecutionWork } from "../unit/capability/action/internal/executions.js";
import { assert, assertNonnegativeNumber, assertPositiveSafeInteger } from "../../common/assert.js";
import { BattlefieldRuntime } from "../battlefield/runtime.js";
import { copyNavigationModifier } from "../battlefield/navigation/modifier.js";
import type { NavigationMaps } from "../battlefield/navigation/map.js";
import { copyProjectileState } from "../battlefield/projectile/state.js";
import { copyUnitSnapshot } from "../unit/snapshot.js";
import type { compileAction } from "../unit/capability/action/compile.js";
import {
    copyActionExecutionState,
    createActionExecutionState,
    type ActionExecutionState,
} from "../unit/capability/action/process.js";
import type { BattleExecutionState } from "./execution/state.js";
import {
    predefinedIdsForAlias,
    copyPredefinedPresence,
    reconcilePredefinedPresence,
    advancePredefined,
    type PredefinedPresence,
} from "./steps/predefined.js";
import type { Input, Command, Result, Snapshot, Step } from "./contract.js";
import { finishBattleEvents } from "./events.js";
import { advanceEffectSources, registerEffectSources } from "./steps/effect-sources.js";
import { CombatResources } from "./resources.js";
import { createCombat } from "./steps/combat.js";
import { advanceBlocking } from "./steps/blocking.js";
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
    cloneScheduleState,
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

function copyResult(result: Result | null): Result | null {
    return result === null ? null : { ...result, remainingUnitIds: [...result.remainingUnitIds] };
}

export class BattleRuntime {
    readonly #input: Input;
    readonly #combat: ReturnType<typeof createCombat>;
    readonly #combatResources: CombatResources;
    #state: BattleRuntimeState;
    #stepping = false;

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
        const predefinedPresence = initializeBattlefield(input, initial, this.#combatResources);
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
        return copyResult(this.#state.result);
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
            spawning: cloneScheduleState(schedule),
            predefinedPresence: copyPredefinedPresence(predefinedPresence),
            actionExecution: copyActionExecutionState(actionExecution),
            projectiles: copyProjectileState({
                nextProjectileId: execution.nextProjectileId,
                instances: view.projectileIds.map((id) => view.getProjectile(id)!),
            }),
            execution: { ...execution },
            units: view.unitIds.map((id) => copyUnitSnapshot(view.getUnit(id)!)),
            blockingRelations: view.blockingRelations.map((relation) => ({ ...relation })),
            supportRelations: view.supportRelations.map((relation) => ({ ...relation })),
            mechanisms: view.mechanismIds.map((id) => ({ ...view.getMechanism(id)! })),
            navigationModifiers: view.navigationModifierIds.map((id) =>
                copyNavigationModifier(view.getNavigationModifier(id)!),
            ),
            completedRouteCount,
            result: copyResult(result),
        };
    }

    step(commands: readonly Command[] = []): Step {
        if (this.#stepping) {
            throw new Error("battle step is already active");
        }

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
        let registrationCursor = 0;

        const settleRegistrations = (): void => {
            while (registrationCursor < state.registeredUnitIds.length) {
                const ids = state.registeredUnitIds.slice(registrationCursor);
                registrationCursor = state.registeredUnitIds.length;
                registerEffectSources(state, ids, tick, resources);
            }
        };

        this.#stepping = true;

        try {
            advanceBattlefield(state, [{ type: "EXPIRE_NAVIGATION_MODIFIERS", tick }]);
            predefinedPresence = advancePredefined(
                state,
                this.#input.predefines,
                predefinedPresence,
                commands,
                tick,
                resources,
            );
            settleRegistrations();

            this.#combat.prepare(state, commands, tick);
            settleRegistrations();

            resolveDeploymentCommands(state, commands, tick, resources);
            settleRegistrations();

            schedule = advanceSpawning(state, schedule, commands, tick);
            settleRegistrations();

            advanceElements(state, tick, resources);
            settleRegistrations();

            advanceSkills(state, commands, tick, resources);
            settleRegistrations();

            advanceEffectSources(state, tick, resources);
            settleRegistrations();

            advanceRouteCommands(state, commands, tick);
            advanceBattlefield(state, advanceBlocking(battlefieldView(state)));

            this.#combat.advance(state, tick);
            settleRegistrations();

            advanceProjectiles(state, tick, commands, resources);
            settleRegistrations();

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
            settleRegistrations();

            advanceEffectSources(state, tick, resources);
            settleRegistrations();

            advanceBattlefield(state, advanceBlocking(battlefieldView(state)));
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

            const output: Step = { events: finishedEvents.events, result: copyResult(result) };

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
        } catch (error) {
            battlefield.drop();
            throw error;
        } finally {
            this.#stepping = false;
        }
    }
}

export function simulateBattle(input: Input): Result {
    const runtime = new BattleRuntime(input);

    while (runtime.result === null) {
        runtime.step();
    }

    return runtime.result;
}
