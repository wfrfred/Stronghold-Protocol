import type {
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldRuntime,
} from "../battlefield/runtime.js";
import { createMovementSystem } from "./movement.js";
import { createBlockingSystem } from "./blocking.js";
import { createCombatSystem } from "./combat.js";
import { createDeploymentSystem } from "./deployment.js";
import { instantiateUnitPlacement } from "./unit-creation.js";
import {
    changePredefinedInstances,
    copyPredefinedPresence,
    createPredefinedSystem,
    type PredefinedPresence,
} from "./predefined.js";
import type { BattleCommand, BattleEvent, BattleResult } from "./contract.js";
import { cloneScheduleState, type SpawnScheduleState } from "./schedule.js";
import { createSpawnScheduleSystem } from "./spawning.js";
import type { BattleSpec } from "./spec.js";
import type { BattleExecutionState } from "./state.js";
import type { BattlePhase } from "./system.js";

export interface BattleSystemStates {
    readonly predefined: readonly PredefinedPresence[];
    readonly schedule: SpawnScheduleState;
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

export function createBattleSystems(spec: BattleSpec) {
    const predefined = createPredefinedSystem(spec.predefines);
    const schedule = createSpawnScheduleSystem(spec.schedule);
    const movement = createMovementSystem({ moveMultiplier: spec.moveMultiplier });
    const blocking = createBlockingSystem();
    const combat = createCombatSystem();
    const deployment = createDeploymentSystem();

    const prepare: BattlePhase<readonly PredefinedPresence[]> = (input, state) => {
        const prepared = predefined.step(input, state);

        return {
            ...prepared,
            changes: [{ type: "EXPIRE_EFFECTS", tick: input.tick }, ...prepared.changes],
        };
    };

    const phases = Object.freeze([
        bindPhase("predefined", prepare),
        bindStatelessPhase(deployment.step),
        bindPhase("schedule", schedule.spawn),
        bindStatelessPhase(movement.reroute),
        bindStatelessPhase(blocking.step),
        bindStatelessPhase(combat.step),
        bindStatelessPhase(movement.step),
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

            const states: BattleSystemStates = {
                predefined: initialized.presence,
                schedule: schedule.createState(),
            };

            return { states, execution: initialized.execution };
        },

        snapshot(states: BattleSystemStates) {
            return {
                spawning: cloneScheduleState(states.schedule),
                predefinedPresence: copyPredefinedPresence(states.predefined),
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

                if (phaseResult.changes.length > 0) {
                    const committed = battlefield.commit(phaseResult.changes);
                    removedUnits.push(...committed.removedUnits);
                    events.push(
                        ...committed.lostSupports.map((relation): BattleEvent => ({
                            type: "SUPPORT_LOST",
                            ...relation,
                            tick,
                        })),
                    );
                }

                states = phaseResult.state;
                execution = phaseResult.execution;
                events.push(...phaseResult.events);
            }

            for (const removed of removedUnits) {
                events.push({ type: "UNIT_REMOVED", ...removed, tick });
            }

            return {
                states,
                execution,
                events,
                completedRouteCount: events.filter((event) => event.type === "ROUTE_COMPLETED")
                    .length,
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
