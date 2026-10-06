import { createBattlefieldRuntime, type BattlefieldRuntime } from "../battlefield/runtime.js";
import type { NavigationMaps } from "../navigation/map.js";
import { createBattleSpec, type BattleSpec } from "./spec.js";
import type { BattleExecutionState } from "./state.js";
import { predefinedIdsForAlias } from "./predefined.js";
import { createBattleSystems, type BattleSystemStates } from "./systems.js";
import type { BattleCommand, BattleResult, BattleSnapshot, BattleStep } from "./contract.js";

export type {
    BattleCommand,
    BattleEvent,
    BattleResult,
    BattleSnapshot,
    BattleStep,
} from "./contract.js";

interface BattleRuntimeState {
    readonly battlefield: BattlefieldRuntime;
    readonly tickIndex: number;
    readonly systems: BattleSystemStates;
    readonly execution: BattleExecutionState;
    readonly completedRouteCount: number;
    readonly result: BattleResult | null;
}

function nextIdentityAfter(ids: readonly number[]): number {
    const next = ids.reduce((next, id) => Math.max(next, id + 1), 0);

    if (!Number.isSafeInteger(next)) {
        throw new RangeError("initial instance identity overflow");
    }

    return next;
}

function copyBattleResult(result: BattleResult | null): BattleResult | null {
    return result === null ? null : { ...result, remainingUnitIds: [...result.remainingUnitIds] };
}

export class BattleRuntime {
    readonly #spec: BattleSpec;
    readonly #systems: ReturnType<typeof createBattleSystems>;
    #state: BattleRuntimeState;

    constructor(spec: BattleSpec) {
        this.#spec = createBattleSpec(spec);
        this.#systems = createBattleSystems(this.#spec);

        const battlefield = createBattlefieldRuntime({ map: this.#spec.map });
        const initialized = this.#systems.initialize(battlefield, {
            rngState: this.#spec.rngState,
            nextUnitId: this.#spec.nextUnitId,
            nextNavigationRequestId: this.#spec.nextNavigationRequestId,
            nextMechanismId: nextIdentityAfter(
                this.#spec.initialMechanisms.map((mechanism) => mechanism.id),
            ),
            nextSpatialEffectId: nextIdentityAfter(
                this.#spec.initialEffects.map((effect) => effect.id),
            ),
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
        return predefinedIdsForAlias(this.#spec.predefines, alias);
    }

    get result(): BattleResult | null {
        return copyBattleResult(this.#state.result);
    }

    snapshot(): BattleSnapshot {
        const { battlefield, tickIndex, systems, execution, completedRouteCount, result } =
            this.#state;

        return {
            tickIndex,
            ...this.#systems.snapshot(systems),
            execution: { ...execution },
            units: battlefield.unitIds.map((id) => battlefield.getUnit(id)!),
            blockingRelations: battlefield.blockingRelations,
            mechanisms: battlefield.mechanismIds.map((id) => battlefield.getMechanism(id)!),
            effects: battlefield.effectIds.map((id) => battlefield.getEffect(id)!),
            completedRouteCount,
            result: copyBattleResult(result),
        };
    }

    step(commands: readonly BattleCommand[] = []): BattleStep {
        if (this.#state.result !== null) {
            return { events: [], result: this.result };
        }

        const workingState: BattleRuntimeState = {
            ...this.#state,
            battlefield: this.#state.battlefield.fork(),
        };
        const advanced = workingState.battlefield.transact(() =>
            this.#advance(workingState, commands),
        );

        this.#state = advanced.state;

        return advanced.output;
    }

    #advance(
        workingState: BattleRuntimeState,
        commands: readonly BattleCommand[],
    ): {
        readonly state: BattleRuntimeState;
        readonly output: BattleStep;
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
            output: { events: stepped.events, result: copyBattleResult(result) },
        };
    }
}

export function simulateBattle(spec: BattleSpec): BattleResult {
    const runtime = new BattleRuntime(spec);

    while (runtime.result === null) {
        runtime.step();
    }

    return runtime.result;
}
