import { assert, assertNonnegativeNumber, assertPositiveSafeInteger } from "../../common/assert.js";
import { BattlefieldRuntime } from "../battlefield/runtime.js";
import type { NavigationMaps } from "../battlefield/navigation/map.js";
import { copyUnitSnapshot } from "../unit/snapshot.js";
import type { BattleExecutionState } from "./execution/state.js";
import { predefinedIdsForAlias, copyPredefinedPresence } from "./predefined.js";
import { createBattlePhases, type BattlePhaseState, type BattleResources } from "./flow.js";
import type { Input, Command, Event, Result, Snapshot, Step } from "./contract.js";
import type { BattlePhase } from "./phase.js";
import type { BattlefieldChangeResult } from "../battlefield/contract.js";
import { battlefieldCommitEvents, finishBattleEvents } from "./events.js";
import { registerEffectSources } from "./phases/effect-sources.js";
import type { CombatResources } from "./resources.js";
import { getSpawnScheduleCounts, isSpawnScheduleCompleted } from "./schedule/runtime.js";
import { cloneScheduleState } from "./schedule/state.js";
import { copyActionExecutionState } from "../unit/capability/action/process.js";
import { copyProjectileState } from "../battlefield/projectile/state.js";

export type { Input, Command, Event, Result, Snapshot, Step } from "./contract.js";

interface BattleRuntimeState {
    readonly battlefield: BattlefieldRuntime;
    readonly tickIndex: number;
    readonly phaseState: BattlePhaseState;
    readonly execution: BattleExecutionState;
    readonly completedRouteCount: number;
    readonly result: Result | null;
}

function copyResult(result: Result | null): Result | null {
    return result === null ? null : { ...result, remainingUnitIds: [...result.remainingUnitIds] };
}

export class BattleRuntime {
    readonly #input: Input;
    readonly #phases: readonly BattlePhase<BattlePhaseState>[];
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
        const assembled = createBattlePhases(this.#input, resources);
        this.#phases = assembled.phases;
        this.#combatResources = assembled.combatResources;

        const battlefield = BattlefieldRuntime.create({ map: this.#input.map }, copyUnitSnapshot);
        const initialized = assembled.initialize(battlefield, {
            rngState: this.#input.rngState,
            nextUnitId: 0,
            nextNavigationRequestId: 0,
            nextMechanismId: 0,
            nextNavigationModifierId: 0,
        });

        this.#state = {
            battlefield,
            phaseState: initialized.phaseState,
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
        return getSpawnScheduleCounts(this.#state.phaseState.schedule);
    }

    snapshot(): Snapshot {
        const { battlefield, tickIndex, phaseState, execution, completedRouteCount, result } =
            this.#state;

        return {
            tickIndex,
            spawning: cloneScheduleState(phaseState.schedule),
            predefinedPresence: copyPredefinedPresence(phaseState.predefined),
            actionExecution: copyActionExecutionState(phaseState.actionExecution),
            projectiles: copyProjectileState(phaseState.projectiles),
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
        let { phaseState, execution } = workingState;
        const events: Event[] = [];
        const removedUnits: BattlefieldChangeResult["removedUnits"][number][] = [];

        for (const phase of this.#phases) {
            const phaseResult = phase(
                { battlefield: battlefield.view, execution, tick, commands, removedUnits },
                phaseState,
            );
            let nextExecution = phaseResult.execution;
            events.push(...phaseResult.events);

            if (phaseResult.changes.length > 0) {
                const committed = battlefield.commitOwned(phaseResult.changes);
                removedUnits.push(...committed.removedUnits);
                events.push(...battlefieldCommitEvents(committed, tick));

                if (committed.registeredUnitIds.length > 0) {
                    const joined = registerEffectSources(
                        {
                            battlefield: battlefield.view,
                            execution: nextExecution,
                            tick,
                            commands,
                            removedUnits,
                        },
                        committed.registeredUnitIds,
                        this.#combatResources,
                    );
                    const installed = battlefield.commitOwned(joined.changes);
                    removedUnits.push(...installed.removedUnits);
                    events.push(...battlefieldCommitEvents(installed, tick), ...joined.events);
                    nextExecution = joined.execution;
                }
            }

            phaseState = phaseResult.state;
            execution = nextExecution;
        }

        const finishedEvents = finishBattleEvents(events, removedUnits, tick);
        const tickIndex = tick + 1;
        const completedRouteCount =
            workingState.completedRouteCount + finishedEvents.completedRouteCount;
        const completed = isSpawnScheduleCompleted(phaseState.schedule);
        const result: Result | null =
            completed || tickIndex >= this.#input.maxTicks
                ? {
                      reason: completed ? "SCHEDULE_COMPLETED" : "TIME_LIMIT",
                      elapsedTicks: tickIndex,
                      completedRouteCount,
                      remainingUnitIds: battlefield.unitIds,
                      ...getSpawnScheduleCounts(phaseState.schedule),
                  }
                : null;

        const output: Step = { events: finishedEvents.events, result: copyResult(result) };

        this.#state = {
            ...workingState,
            tickIndex,
            completedRouteCount,
            result,
            phaseState,
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
