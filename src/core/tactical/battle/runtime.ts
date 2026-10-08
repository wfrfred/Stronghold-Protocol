import { assert, assertNonnegativeNumber, assertPositiveSafeInteger } from "../../common/assert.js";

import { BattlefieldRuntime } from "../battlefield/runtime.js";
import type { NavigationMaps } from "../battlefield/navigation/map.js";
import { copyUnitSnapshot } from "../unit/snapshot.js";
import type { BattleExecutionState } from "./execution/state.js";
import { predefinedIdsForAlias } from "./predefined.js";
import { createBattleSystems, type BattleSystemStates, type BattleResources } from "./systems.js";
import type { Input, Command, Result, Snapshot, Step } from "./contract.js";

export type { Input, Command, Event, Result, Snapshot, Step } from "./contract.js";

interface BattleRuntimeState {
    readonly battlefield: BattlefieldRuntime;
    readonly tickIndex: number;
    readonly systems: BattleSystemStates;
    readonly execution: BattleExecutionState;
    readonly completedRouteCount: number;
    readonly result: Result | null;
}

function copyResult(result: Result | null): Result | null {
    return result === null ? null : { ...result, remainingUnitIds: [...result.remainingUnitIds] };
}

export class BattleRuntime {
    readonly #input: Input;
    readonly #systems: ReturnType<typeof createBattleSystems>;
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
        this.#systems = createBattleSystems(this.#input, resources);

        const battlefield = BattlefieldRuntime.create({ map: this.#input.map }, copyUnitSnapshot);
        const initialized = this.#systems.initialize(battlefield, {
            rngState: this.#input.rngState,
            nextUnitId: 0,
            nextNavigationRequestId: 0,
            nextMechanismId: 0,
            nextNavigationModifierId: 0,
        });

        this.#state = {
            battlefield,
            systems: initialized.states,
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
        return this.#systems.spawnCounts(this.#state.systems);
    }

    snapshot(): Snapshot {
        const { battlefield, tickIndex, systems, execution, completedRouteCount, result } =
            this.#state;

        return {
            tickIndex,
            ...this.#systems.snapshot(systems),
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
        const advanced = this.#advance(workingState, commands);

        this.#state = advanced.state;

        return advanced.output;
    }

    #advance(
        workingState: BattleRuntimeState,
        commands: readonly Command[],
    ): {
        readonly state: BattleRuntimeState;
        readonly output: Step;
    } {
        const stepped = this.#systems.step(
            workingState.battlefield,
            workingState.systems,
            workingState.execution,
            workingState.tickIndex,
            commands,
        );

        const tickIndex = workingState.tickIndex + 1;
        const completedRouteCount = workingState.completedRouteCount + stepped.completedRouteCount;
        const result = this.#systems.finish(
            stepped.states,
            tickIndex,
            completedRouteCount,
            workingState.battlefield.unitIds,
        );

        return {
            state: {
                ...workingState,
                tickIndex,
                completedRouteCount,
                result,
                systems: stepped.states,
                execution: stepped.execution,
            },
            output: { events: stepped.events, result: copyResult(result) },
        };
    }
}

export function simulateBattle(input: Input): Result {
    const runtime = new BattleRuntime(input);

    while (runtime.result === null) {
        runtime.step();
    }

    return runtime.result;
}
