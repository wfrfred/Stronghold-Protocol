import type { Ref } from "../../../common/ref.js";
import type { State as BattleState, Result } from "../state.js";
import type { Unit } from "../../unit/unit.js";
import * as units from "../../unit/query.js";
import * as hooks from "../../unit/hook/hook.js";
import { hasVitality, type State } from "../../unit/capability/vitality/capability.js";
import type {
    ApplicationResult,
    CalculatedHealing,
    HealingOutcome,
    HealingParameters,
    HealingRequest,
    PendingHealing,
} from "./contract.js";

export interface CalculationContext {
    readonly request: HealingRequest;
}

export interface ReceivingContext {
    readonly request: HealingRequest;
    readonly calculated: CalculatedHealing;
}

export interface AppliedContext extends ReceivingContext {
    readonly received: PendingHealing;
    readonly application: ApplicationResult;
}

export interface CompletedContext {
    readonly request: HealingRequest;
    readonly calculated: CalculatedHealing | undefined;
    readonly outcome: HealingOutcome;
}

interface Entry<C, T> extends hooks.Hook<C, T> {
    readonly priority: number;
}

export interface ParametersHook extends Entry<HealingRequest, HealingParameters> {
    readonly stage: "sourceFormula" | "targetFormula";
}

export interface OutputHook extends Entry<CalculationContext, number> {
    readonly stage: "output";
}

export interface ReceivingStartedHook extends Entry<ReceivingContext, void> {
    readonly stage: "receivingStarted";
}

export interface ReceivingHook extends Entry<ReceivingContext, PendingHealing> {
    readonly stage: "receiving";
}

export interface HpAppliedHook extends Entry<AppliedContext, void> {
    readonly stage: "hpApplied";
}

export interface CompletedHook extends Entry<CompletedContext, void> {
    readonly stage: "completed";
}

export type Hook =
    | ParametersHook
    | OutputHook
    | ReceivingStartedHook
    | ReceivingHook
    | HpAppliedHook
    | CompletedHook;

export function setHook(state: State, entry: Hook): State {
    const healingHooks = hooks.set(state.healingHooks, entry);

    return healingHooks === state.healingHooks ? state : { ...state, healingHooks };
}

export function removeHook(state: State, id: string): State {
    const healingHooks = hooks.remove(state.healingHooks, id);

    return healingHooks === state.healingHooks ? state : { ...state, healingHooks };
}

export function dispatch<C, T>(
    battle: BattleState,
    owner: Ref<Unit> | null,
    context: C,
    initial: T,
    select: (entry: Hook) => Entry<C, T> | undefined,
    stop?: (battle: BattleState) => boolean,
): Result<T> {
    if (owner === null) {
        return { state: battle, value: initial };
    }

    return hooks.dispatch(battle, context, initial, {
        candidates(current) {
            const unit = units.get(current, owner);

            return unit !== undefined && hasVitality(unit) && unit.lifecycle === "PRESENT"
                ? unit.vitality.healingHooks
                      .flatMap((entry) => {
                          const selected = select(entry);

                          return selected === undefined
                              ? []
                              : [{ id: selected.id, priority: selected.priority }];
                      })
                      .sort((left, right) => right.priority - left.priority)
                      .map(({ id }) => id)
                : [];
        },
        find(current, id) {
            const unit = units.get(current, owner);

            if (unit === undefined || !hasVitality(unit) || unit.lifecycle !== "PRESENT") {
                return undefined;
            }

            const entry = unit.vitality.healingHooks.find((candidate) => candidate.id === id);

            return entry === undefined ? undefined : select(entry);
        },
        ...(stop === undefined ? {} : { stop: (current: BattleState) => stop(current) }),
    });
}
