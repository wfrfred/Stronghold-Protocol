import { assert, assertNonnegativeNumber, assertPositiveSafeInteger } from "../../common/assert.js";
import { BattlefieldRuntime } from "../battlefield/runtime.js";
import type { BattlefieldChange, BattlefieldChangeResult } from "../battlefield/contract.js";
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
import type { Input, Command, Event, Result, Snapshot, Step } from "./contract.js";
import { battlefieldCommitEvents, finishBattleEvents } from "./events.js";
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
        const view = battlefield.view;
        let { schedule, actionExecution, predefinedPresence, execution } = workingState;
        const resources = this.#combatResources;
        const events: Event[] = [];
        const removedUnits: BattlefieldChangeResult["removedUnits"][number][] = [];

        const commit = (
            result:
                | readonly BattlefieldChange[]
                | {
                      readonly changes: readonly BattlefieldChange[];
                      readonly events: readonly Event[];
                      readonly execution: BattleExecutionState;
                  },
        ): void => {
            const changes = "changes" in result ? result.changes : result;

            if ("changes" in result) {
                execution = result.execution;
                events.push(...result.events);
            }

            if (changes.length === 0) {
                return;
            }

            const committed = battlefield.commitOwned(changes);
            removedUnits.push(...committed.removedUnits);
            events.push(...battlefieldCommitEvents(committed, tick));

            if (committed.registeredUnitIds.length > 0) {
                const joined = registerEffectSources(
                    { battlefield: view, execution, tick },
                    committed.registeredUnitIds,
                    resources,
                );
                const installed = battlefield.commitOwned(joined.changes);
                removedUnits.push(...installed.removedUnits);
                events.push(...battlefieldCommitEvents(installed, tick), ...joined.events);
                execution = joined.execution;
            }
        };

        const predefined = advancePredefined(
            this.#input.predefines,
            predefinedPresence,
            { battlefield: view, execution, tick, commands },
            resources,
        );
        predefinedPresence = predefined.presence;
        commit({
            ...predefined,
            changes: [{ type: "EXPIRE_NAVIGATION_MODIFIERS", tick }, ...predefined.changes],
        });

        const prepared = this.#combat.prepare(
            { battlefield: view, execution, tick, commands },
            actionExecution,
        );
        actionExecution = prepared.actionExecution;
        commit(prepared);

        const deployed = resolveDeploymentCommands(view, commands, execution, tick, resources);
        commit(deployed);

        const spawned = advanceSpawning({ tick, execution, commands }, schedule);
        schedule = spawned.schedule;
        commit(spawned);

        const elemental = advanceElements({ battlefield: view, execution, tick }, resources);
        commit(elemental);

        const skills = advanceSkills({ battlefield: view, execution, tick, commands }, resources);
        commit(skills);

        const sources = advanceEffectSources({ battlefield: view, execution, tick }, resources);
        commit(sources);

        const routed = advanceRouteCommands(view, commands, execution, tick);
        commit(routed);

        commit(advanceBlocking(view));

        const acted = this.#combat.advance({ battlefield: view, execution, tick }, actionExecution);
        actionExecution = acted.actionExecution;
        commit(acted);

        const projectiles = advanceProjectiles(view, execution, tick, commands, resources);
        commit(projectiles);

        const moved = advanceMovement(
            {
                battlefield: view,
                execution,
                tick,
                movementAllowed: (unitId) => this.#combat.allowsMovement(actionExecution, unitId),
            },
            { routeMoveMultiplier: this.#input.routeMoveMultiplier },
            resources,
        );
        commit(moved);

        const reconciledSources = advanceEffectSources(
            { battlefield: view, execution, tick },
            resources,
        );
        commit(reconciledSources);

        commit(advanceBlocking(view));
        predefinedPresence = reconcilePredefinedPresence(predefinedPresence, view);
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
