import type { BattlefieldChange, BattlefieldChangeResult } from "../battlefield/contract.js";
import type { BattlefieldRuntime } from "../battlefield/runtime.js";
import { createMovementSystem } from "./phases/movement.js";
import { createBlockingSystem } from "./phases/blocking.js";
import { createCombatSystem } from "./phases/combat.js";
import { createDeploymentSystem } from "./phases/deployment.js";
import { instantiateUnitPlacement } from "./creation/placement.js";
import {
    changePredefinedInstances,
    copyPredefinedPresence,
    createPredefinedSystem,
    type PredefinedPresence,
} from "./predefined.js";
import type { BattleCommand, BattleEvent, BattleResult } from "./contract.js";
import { cloneScheduleState, type SpawnScheduleExecution } from "./schedule/state.js";
import { createSpawnScheduleSystem } from "./phases/spawning.js";
import type { BattleSpec } from "./spec.js";
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

export function createBattleSystems(spec: BattleSpec, resources: BattleResources = {}) {
    const combatResources = (resources.combat ?? new CombatResources()).seal();
    const predefined = createPredefinedSystem(spec.predefines, combatResources);
    const schedule = createSpawnScheduleSystem(spec.schedule);
    const movement = createMovementSystem({ moveMultiplier: spec.moveMultiplier }, combatResources);
    const blocking = createBlockingSystem();
    const combat = createCombatSystem(combatResources, resources.compileAction);
    const deployment = createDeploymentSystem(combatResources);
    const effectSources = createEffectSourceSystem(combatResources);
    const projectiles = createProjectileSystem(combatResources);

    const prepare: BattlePhase<readonly PredefinedPresence[]> = (input, state) => {
        const prepared = predefined.step(input, state);

        return {
            ...prepared,
            changes: [{ type: "EXPIRE_EFFECTS", tick: input.tick }, ...prepared.changes],
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

            for (const placement of spec.initialUnits ?? []) {
                const instantiated = instantiateUnitPlacement(placement, execution, 0);

                initialChanges.push(...instantiated.changes);
                execution = instantiated.execution;
            }

            const initialized = changePredefinedInstances(
                spec.predefines,
                predefined.createState(),
                spec.predefines
                    .filter((definition) => definition.initiallyPresent)
                    .map((definition) => ({
                        type: "APPEAR_PREDEFINED",
                        definitionId: definition.id,
                    })),
                execution,
            );

            battlefield.apply([
                ...initialChanges,
                ...spec.initialMechanisms.map((mechanism) => ({
                    type: "REGISTER_MECHANISM" as const,
                    mechanism,
                })),
                ...spec.initialEffects.map((effect) => ({ type: "ADD_EFFECT" as const, effect })),
                ...initialized.changes,
            ]);

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
            commands: readonly BattleCommand[],
        ) {
            const events: BattleEvent[] = [];
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
            remainingUnitIds: BattleResult["remainingUnitIds"],
        ): BattleResult | null {
            const completed = schedule.isCompleted(states.schedule);

            if (!completed && elapsedTicks < spec.maxTicks) {
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
