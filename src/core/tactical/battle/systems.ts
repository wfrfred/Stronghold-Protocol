import type { BattlefieldChange, BattlefieldChangeResult } from "../battlefield/contract.js";
import type { BattlefieldRuntime } from "../battlefield/runtime.js";
import { createMovementSystem } from "./phases/movement.js";
import { createBlockingSystem } from "./phases/blocking.js";
import { createCombatSystem } from "./phases/combat.js";
import { createDeploymentSystem } from "./phases/deployment.js";
import { instantiateUnitPlacement } from "./creation/placement.js";
import { instantiateMechanismPlacement } from "./creation/mechanism.js";
import { instantiateNavigationModifierPlacement } from "./creation/navigation-modifier.js";
import { createSpawnScheduleDefinition } from "./schedule/definition.js";
import {
    changePredefinedInstances,
    copyPredefinedPresence,
    createPredefinedSystem,
    type PredefinedPresence,
} from "./predefined.js";
import type { Input, Command, Event, Result } from "./contract.js";
import { cloneScheduleState, type SpawnScheduleExecution } from "./schedule/state.js";
import { createSpawnScheduleSystem } from "./phases/spawning.js";
import type { BattleExecutionState } from "./execution/state.js";
import type { BattlePhase } from "./system.js";
import { battlefieldCommitEvents, finishBattleEvents } from "./events.js";
import { CombatResources } from "./resources.js";
import type { compileAction } from "../unit/capability/action/compile.js";
import { createEffectSourceSystem } from "./phases/effect-sources.js";
import {
    copyActionExecutionState,
    type ActionExecutionState,
} from "../unit/capability/action/process.js";
import { createProjectileSystem } from "./phases/projectiles.js";
import { copyProjectileState, type ProjectileState } from "../battlefield/projectile/state.js";
import { withProjectileOperations } from "../battlefield/projectile/operations.js";
import { advanceSkills } from "./phases/skills.js";

export interface BattleResources {
    readonly combat?: CombatResources;
    readonly compileAction?: typeof compileAction;
}

export interface BattleSystemStates {
    readonly predefined: readonly PredefinedPresence[];
    readonly schedule: SpawnScheduleExecution;
    readonly actionExecution: ActionExecutionState;
    readonly projectiles: ProjectileState;
}

function bindPhase<K extends keyof BattleSystemStates>(
    slot: K,
    phase: BattlePhase<BattleSystemStates[K]>,
): BattlePhase<BattleSystemStates> {
    return (input, states) => {
        const phaseResult = phase(input, states[slot]);

        return {
            ...phaseResult,
            state:
                phaseResult.state === states[slot]
                    ? states
                    : { ...states, [slot]: phaseResult.state },
        };
    };
}

function bindStatelessPhase(phase: BattlePhase): BattlePhase<BattleSystemStates> {
    return (input, state) => ({ ...phase(input, undefined), state });
}

export function createBattleSystems(input: Input, resources: BattleResources = {}) {
    const combatResources = (resources.combat ?? new CombatResources()).seal();
    const predefined = createPredefinedSystem(input.predefines, combatResources);
    const schedule = createSpawnScheduleSystem(createSpawnScheduleDefinition(input.schedule));
    const movement = createMovementSystem(
        { routeMoveMultiplier: input.routeMoveMultiplier },
        combatResources,
    );
    const blocking = createBlockingSystem();
    const combat = createCombatSystem(combatResources, resources.compileAction);
    const deployment = createDeploymentSystem(combatResources);
    const effectSources = createEffectSourceSystem(combatResources);
    const projectiles = createProjectileSystem(combatResources);

    const prepare: BattlePhase<readonly PredefinedPresence[]> = (input, state) => {
        const prepared = predefined.step(input, state);

        return {
            ...prepared,
            changes: [
                { type: "EXPIRE_NAVIGATION_MODIFIERS", tick: input.tick },
                ...prepared.changes,
            ],
        };
    };

    const move: BattlePhase<BattleSystemStates> = (input, state) => ({
        ...movement.step(
            {
                ...input,
                movementAllowed: (unitId) => combat.allowsMovement(state.actionExecution, unitId),
            },
            undefined,
        ),
        state,
    });

    const act: BattlePhase<BattleSystemStates> = (input, state) => {
        const advanced = withProjectileOperations(
            state.projectiles,
            combatResources.projectiles,
            input.tick,
            (operations) =>
                combat.step({ ...input, projectiles: operations }, state.actionExecution),
        );

        return {
            ...advanced.result,
            state: {
                ...state,
                actionExecution: advanced.result.state,
                projectiles: advanced.state,
            },
        };
    };

    const phases = Object.freeze([
        bindPhase("predefined", prepare),
        bindPhase("actionExecution", combat.prepare),
        bindStatelessPhase(deployment.step),
        bindPhase("schedule", schedule.spawn),
        bindStatelessPhase((input) => advanceSkills(input, combatResources)),
        bindStatelessPhase(effectSources.step),
        bindStatelessPhase(movement.reroute),
        bindStatelessPhase(blocking.step),
        act,
        bindPhase("projectiles", projectiles.step),
        move,
        bindStatelessPhase(effectSources.step),
        bindStatelessPhase(blocking.step),
        bindPhase("predefined", predefined.resolve),
        bindPhase("schedule", schedule.resolve),
    ]);

    return {
        initialize(battlefield: BattlefieldRuntime, execution: BattleExecutionState) {
            const initialChanges: BattlefieldChange[] = [];
            const initialUnitIds: number[] = [];
            const initialMechanismIds: number[] = [];

            for (const placement of input.initialUnits) {
                const instantiated = instantiateUnitPlacement(placement, execution, 0);

                initialChanges.push(...instantiated.changes);
                initialUnitIds.push(instantiated.unit.id);
                execution = instantiated.execution;
            }

            for (const placement of input.initialMechanisms) {
                const instantiated = instantiateMechanismPlacement(
                    placement,
                    execution,
                    initialUnitIds,
                );
                initialChanges.push(...instantiated.changes);
                initialMechanismIds.push(instantiated.mechanism.id);
                execution = instantiated.execution;
            }
            for (const placement of input.initialNavigationModifiers) {
                const instantiated = instantiateNavigationModifierPlacement(
                    placement,
                    execution,
                    initialUnitIds,
                    initialMechanismIds,
                );
                initialChanges.push(...instantiated.changes);
                execution = instantiated.execution;
            }

            const initialized = changePredefinedInstances(
                input.predefines,
                predefined.createState(),
                input.predefines
                    .filter((definition) => definition.initiallyPresent)
                    .map((definition) => ({
                        type: "APPEAR_PREDEFINED",
                        definitionId: definition.id,
                    })),
                execution,
            );

            battlefield.apply([...initialChanges, ...initialized.changes]);

            const preparedSources = effectSources.step(
                {
                    battlefield: battlefield.view,
                    tick: 0,
                    commands: [],
                    execution: initialized.execution,
                    removedUnits: [],
                },
                undefined,
            );
            battlefield.commit(preparedSources.changes);

            const states: BattleSystemStates = {
                predefined: initialized.presence,
                schedule: schedule.createState(),
                actionExecution: combat.createState(),
                projectiles: projectiles.createState(),
            };

            return { states, execution: preparedSources.execution };
        },

        spawnCounts(states: BattleSystemStates) {
            return schedule.counts(states.schedule);
        },

        snapshot(states: BattleSystemStates) {
            return {
                spawning: cloneScheduleState(states.schedule),
                predefinedPresence: copyPredefinedPresence(states.predefined),
                actionExecution: copyActionExecutionState(states.actionExecution),
                projectiles: copyProjectileState(states.projectiles),
            };
        },

        step(
            battlefield: BattlefieldRuntime,
            states: BattleSystemStates,
            execution: BattleExecutionState,
            tick: number,
            commands: readonly Command[],
        ) {
            const events: Event[] = [];
            const removedUnits: BattlefieldChangeResult["removedUnits"][number][] = [];

            for (const phase of phases) {
                const phaseResult = phase(
                    { battlefield: battlefield.view, execution, tick, commands, removedUnits },
                    states,
                );
                let nextExecution = phaseResult.execution;
                events.push(...phaseResult.events);

                if (phaseResult.changes.length > 0) {
                    const committed = battlefield.commit(phaseResult.changes);
                    removedUnits.push(...committed.removedUnits);
                    events.push(...battlefieldCommitEvents(committed, tick));

                    if (committed.registeredUnitIds.length > 0) {
                        const joined = effectSources.register(
                            {
                                battlefield: battlefield.view,
                                execution: nextExecution,
                                tick,
                                commands,
                                removedUnits,
                            },
                            committed.registeredUnitIds,
                        );
                        const installed = battlefield.commit(joined.changes);
                        removedUnits.push(...installed.removedUnits);
                        events.push(...battlefieldCommitEvents(installed, tick), ...joined.events);
                        nextExecution = joined.execution;
                    }
                }

                states = phaseResult.state;
                execution = nextExecution;
            }

            return {
                states,
                execution,
                ...finishBattleEvents(events, removedUnits, tick),
            };
        },

        finish(
            states: BattleSystemStates,
            elapsedTicks: number,
            completedRouteCount: number,
            remainingUnitIds: Result["remainingUnitIds"],
        ): Result | null {
            const completed = schedule.isCompleted(states.schedule);

            if (!completed && elapsedTicks < input.maxTicks) {
                return null;
            }

            return {
                reason: completed ? "SCHEDULE_COMPLETED" : "TIME_LIMIT",
                elapsedTicks,
                completedRouteCount,
                remainingUnitIds,
                ...schedule.counts(states.schedule),
            };
        },
    };
}
