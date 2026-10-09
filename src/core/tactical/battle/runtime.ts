import { assert, assertNonnegativeNumber, assertPositiveSafeInteger } from "../../common/assert.js";
import { BattlefieldRuntime } from "../battlefield/runtime.js";
import type { BattlefieldChange, BattlefieldChangeResult } from "../battlefield/contract.js";
import type { NavigationMaps } from "../battlefield/navigation/map.js";
import { copyProjectileState } from "../battlefield/projectile/state.js";
import { withProjectileOperations } from "../battlefield/projectile/operations.js";
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
    changePredefinedInstances,
    settlePredefinedChanges,
    type PredefinedPresence,
} from "./predefined.js";
import type { Input, Command, Event, Result, Snapshot, Step } from "./contract.js";
import { battlefieldCommitEvents, finishBattleEvents } from "./events.js";
import { advanceEffectSources, registerEffectSources } from "./effect-sources.js";
import { CombatResources } from "./resources.js";
import { createCombat } from "./combat.js";
import { advanceBlocking } from "./blocking.js";
import { advanceSpawning } from "./spawning.js";
import { resolveDeploymentCommands } from "./deployment.js";
import { advanceMovement, advanceRouteCommands } from "./movement.js";
import { advanceProjectiles } from "./projectiles.js";
import { advanceElements } from "./elemental.js";
import { advanceSkills } from "./skills.js";
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

        const battlefield = BattlefieldRuntime.create({ map: this.#input.map }, copyUnitSnapshot);
        const initialized = initializeBattlefield(
            input,
            battlefield,
            {
                rngState: input.rngState,
                nextUnitId: 0,
                nextNavigationRequestId: 0,
                nextMechanismId: 0,
                nextNavigationModifierId: 0,
                nextProjectileId: 0,
            },
            this.#combatResources,
        );

        this.#state = {
            battlefield,
            schedule: createSpawnScheduleExecution(scheduleDefinition),
            actionExecution: createActionExecutionState(),
            predefinedPresence: initialized.predefinedPresence,
            execution: initialized.execution,
            tickIndex: 0,
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

        return {
            tickIndex,
            spawning: cloneScheduleState(schedule),
            predefinedPresence: copyPredefinedPresence(predefinedPresence),
            actionExecution: copyActionExecutionState(actionExecution),
            projectiles: copyProjectileState({
                nextProjectileId: execution.nextProjectileId,
                instances: battlefield.projectileIds.map((id) => battlefield.getProjectile(id)!),
            }),
            execution: { ...execution },
            units: battlefield.unitIds.map((id) => battlefield.getUnit(id)!),
            blockingRelations: battlefield.blockingRelations,
            supportRelations: battlefield.supportRelations,
            mechanisms: battlefield.mechanismIds.map((id) => battlefield.getMechanism(id)!),
            navigationModifiers: battlefield.navigationModifierIds.map((id) =>
                battlefield.getNavigationModifier(id)!,
            ),
            completedRouteCount,
            result: copyResult(result),
        };
    }

    step(commands: readonly Command[] = []): Step {
        if (this.#state.result !== null) {
            return { events: [], result: this.result };
        }

        const workingState: BattleRuntimeState = {
            ...this.#state,
            battlefield: this.#state.battlefield.fork(),
        };
        const { battlefield, tickIndex: tick } = workingState;
        let { schedule, actionExecution, predefinedPresence, execution } = workingState;
        const resources = this.#combatResources;
        const events: Event[] = [];
        const removedUnits: BattlefieldChangeResult["removedUnits"][number][] = [];

        const commit = (changes: readonly BattlefieldChange[]): void => {
            if (changes.length === 0) {
                return;
            }

            const committed = battlefield.commitOwned(changes);
            removedUnits.push(...committed.removedUnits);
            events.push(...battlefieldCommitEvents(committed, tick));

            if (committed.registeredUnitIds.length > 0) {
                const joined = registerEffectSources(
                    { battlefield: battlefield.view, execution, tick },
                    committed.registeredUnitIds,
                    resources,
                );
                const installed = battlefield.commitOwned(joined.changes);
                removedUnits.push(...installed.removedUnits);
                events.push(...battlefieldCommitEvents(installed, tick), ...joined.events);
                execution = joined.execution;
            }
        };

        const predefined = settlePredefinedChanges(
            battlefield.view,
            changePredefinedInstances(
                this.#input.predefines,
                reconcilePredefinedPresence(predefinedPresence, battlefield.view),
                commands.filter(
                    (command) =>
                        command.type === "APPEAR_PREDEFINED" ||
                        command.type === "REMOVE_PREDEFINED",
                ),
                execution,
                tick,
            ),
            resources,
            tick,
        );
        predefinedPresence = predefined.presence;
        execution = predefined.execution;
        events.push(...predefined.events);
        commit([{ type: "EXPIRE_NAVIGATION_MODIFIERS", tick }, ...predefined.changes]);

        const prepared = this.#combat.prepare(
            {
                battlefield: battlefield.view,
                tick,
                execution,
                commands: commands.filter((command) => command.type === "CANCEL_ACTION_EXECUTION"),
            },
            actionExecution,
        );
        actionExecution = prepared.actionExecution;
        execution = prepared.execution;
        events.push(...prepared.events);
        commit(prepared.changes);

        const deployed = resolveDeploymentCommands(
            battlefield.view,
            commands.filter(
                (command) =>
                    command.type === "DEPLOY_UNIT" ||
                    command.type === "RELOCATE_UNIT" ||
                    command.type === "RETREAT_UNIT",
            ),
            execution,
            tick,
            resources,
        );
        execution = deployed.execution;
        events.push(...deployed.events);
        commit(deployed.changes);

        const spawned = advanceSpawning(
            {
                tick,
                execution,
                triggers: commands.filter((command) => command.type === "TRIGGER_BRANCH"),
            },
            schedule,
        );
        schedule = spawned.schedule;
        execution = spawned.execution;
        events.push(...spawned.events);
        commit(spawned.changes);

        const elemental = advanceElements(
            { battlefield: battlefield.view, execution, tick },
            resources,
        );
        execution = elemental.execution;
        events.push(...elemental.events);
        commit(elemental.changes);

        const skills = advanceSkills(
            {
                battlefield: battlefield.view,
                execution,
                tick,
                commands: commands.filter(
                    (command) =>
                        command.type === "ACTIVATE_SKILL" || command.type === "FINISH_SKILL",
                ),
            },
            resources,
        );
        execution = skills.execution;
        events.push(...skills.events);
        commit(skills.changes);

        const sources = advanceEffectSources(
            { battlefield: battlefield.view, execution, tick },
            resources,
        );
        execution = sources.execution;
        events.push(...sources.events);
        commit(sources.changes);

        const routed = advanceRouteCommands(
            battlefield.view,
            commands.filter(
                (command) =>
                    command.type === "SET_ALTERNATIVE_ROUTE" ||
                    command.type === "CLEAR_ALTERNATIVE_ROUTE",
            ),
            execution,
            tick,
        );
        execution = routed.execution;
        events.push(...routed.events);
        commit(routed.changes);

        commit(advanceBlocking(battlefield.view));

        const acted = withProjectileOperations(
            battlefield.view,
            execution,
            resources.projectiles,
            tick,
            (projectiles) =>
                this.#combat.advance(
                    { battlefield: battlefield.view, execution, tick, projectiles },
                    actionExecution,
                ),
        );
        actionExecution = acted.result.actionExecution;
        execution = {
            ...acted.result.execution,
            nextProjectileId: acted.execution.nextProjectileId,
        };
        events.push(...acted.result.events);
        commit([...acted.result.changes, ...acted.changes]);

        const projectiles = advanceProjectiles(
            battlefield.view,
            execution,
            tick,
            commands
                .filter((command) => command.type === "STOP_PROJECTILE")
                .map((command) => command.projectileId),
            resources,
        );
        execution = projectiles.execution;
        events.push(...projectiles.events);
        commit(projectiles.changes);

        const moved = advanceMovement(
            {
                battlefield: battlefield.view,
                execution,
                tick,
                movementAllowed: (unitId) => this.#combat.allowsMovement(actionExecution, unitId),
            },
            { routeMoveMultiplier: this.#input.routeMoveMultiplier },
            resources,
        );
        execution = moved.execution;
        events.push(...moved.events);
        commit(moved.changes);

        const reconciledSources = advanceEffectSources(
            { battlefield: battlefield.view, execution, tick },
            resources,
        );
        execution = reconciledSources.execution;
        events.push(...reconciledSources.events);
        commit(reconciledSources.changes);

        commit(advanceBlocking(battlefield.view));
        predefinedPresence = reconcilePredefinedPresence(predefinedPresence, battlefield.view);
        schedule = resolveScheduleUnits(
            schedule,
            removedUnits.map((removed) => removed.unitId),
        );

        const finishedEvents = finishBattleEvents(events, removedUnits, tick);
        const tickIndex = tick + 1;
        const completedRouteCount =
            workingState.completedRouteCount + finishedEvents.completedRouteCount;
        const completed = isSpawnScheduleCompleted(schedule);
        const result: Result | null =
            completed || tickIndex >= this.#input.maxTicks
                ? {
                      reason: completed ? "SCHEDULE_COMPLETED" : "TIME_LIMIT",
                      elapsedTicks: tickIndex,
                      completedRouteCount,
                      remainingUnitIds: battlefield.unitIds,
                      ...getSpawnScheduleCounts(schedule),
                  }
                : null;

        const output: Step = { events: finishedEvents.events, result: copyResult(result) };

        this.#state = {
            ...workingState,
            tickIndex,
            completedRouteCount,
            result,
            schedule,
            actionExecution,
            predefinedPresence,
            execution,
        };

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
