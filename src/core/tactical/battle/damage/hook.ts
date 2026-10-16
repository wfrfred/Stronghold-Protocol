import type { Ref } from "../../../common/ref.js";
import type { State as BattleState, Result } from "../state.js";
import type { Unit } from "../../unit/unit.js";
import * as units from "../../unit/query.js";
import * as hooks from "../../unit/hook/hook.js";
import { hasVitality, type State } from "../../unit/capability/vitality/capability.js";
import type {
    ApplicationResult,
    CalculatedDamage,
    DamageOutcome,
    DamageParameters,
    DamageRequest,
    DamageType,
    PendingDamage,
} from "./contract.js";

export interface CalculationContext {
    readonly request: DamageRequest;
    readonly type: DamageType;
}

export interface ReceivingContext {
    readonly request: DamageRequest;
    readonly calculated: CalculatedDamage;
}

export interface AppliedContext extends ReceivingContext {
    readonly received: PendingDamage;
    readonly application: ApplicationResult;
}

export interface CompletedContext {
    readonly request: DamageRequest;
    readonly calculated: CalculatedDamage | undefined;
    readonly outcome: DamageOutcome;
}

interface Entry<C, T> extends hooks.Hook<C, T> {
    readonly priority: number;
}

export interface ParametersHook extends Entry<DamageRequest, DamageParameters> {
    readonly stage: "sourceFormula" | "targetFormula";
}

export interface OutputHook extends Entry<CalculationContext, number> {
    readonly stage: "output";
}

export interface ReceivingStartedHook extends Entry<ReceivingContext, void> {
    readonly stage: "receivingStarted";
}

export interface ReceivingHook extends Entry<ReceivingContext, PendingDamage> {
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

export interface ReceptionRule {
    readonly id: string;
    readonly allows: (battle: BattleState, context: ReceivingContext) => boolean;
}

export function setHook(state: State, entry: Hook): State {
    const damageHooks = hooks.set(state.damageHooks, entry);

    return damageHooks === state.damageHooks ? state : { ...state, damageHooks };
}

export function removeHook(state: State, id: string): State {
    const damageHooks = hooks.remove(state.damageHooks, id);

    return damageHooks === state.damageHooks ? state : { ...state, damageHooks };
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
                ? unit.vitality.damageHooks
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

            const entry = unit.vitality.damageHooks.find((candidate) => candidate.id === id);

            return entry === undefined ? undefined : select(entry);
        },
        ...(stop === undefined ? {} : { stop: (current: BattleState) => stop(current) }),
    });
}
