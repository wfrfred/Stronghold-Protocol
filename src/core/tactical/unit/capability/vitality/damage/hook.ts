import type { State as BattleState } from "../../../../battle/state.js";
import * as hook from "../../../hook/hook.js";
import type { State, Vitality } from "../capability.js";
import type { Context as VitalityContext, Result } from "../hook.js";
import type { Unit } from "../../../unit.js";
import type { DamageOperands, DamageReport, DamageRequest, PendingDamage } from "./contract.js";

export type Context = VitalityContext<DamageRequest>;

export type FormulaStage = "sourceFormula" | "targetFormula";

export type AmountStage = "output" | "reception" | "skippedReception";

export interface FormulaHook extends hook.Hook<
    BattleState,
    Context,
    DamageOperands,
    Result<DamageOperands>
> {
    readonly stage: FormulaStage;
    readonly priority: number;
}

export interface AmountHook extends hook.Hook<
    BattleState,
    Context,
    PendingDamage,
    Result<PendingDamage>
> {
    readonly stage: AmountStage;
    readonly priority: number;
}

export interface ReactionHook extends hook.Hook<
    BattleState,
    Context,
    DamageReport,
    undefined | { readonly stopDispatch?: boolean }
> {
    readonly stage: "reaction";
    readonly priority: number;
}

export interface Received {
    readonly request: DamageRequest;
    readonly pending: PendingDamage;
}

export interface ReceivedHook {
    readonly id: string;
    readonly stage: "received";
    readonly enabled: (battle: BattleState, self: Unit & Vitality, event: Received) => boolean;
    readonly invoke: (battle: BattleState, self: Unit & Vitality, event: Received) => BattleState;
}

export type Hook = FormulaHook | AmountHook | ReactionHook | ReceivedHook;

export function setHook(state: State, entry: Hook): State {
    const damageHooks = hook.set(state.damageHooks, entry);

    return damageHooks === state.damageHooks ? state : { ...state, damageHooks };
}

export function removeHook(state: State, id: string): State {
    const damageHooks = hook.remove(state.damageHooks, id);

    return damageHooks === state.damageHooks ? state : { ...state, damageHooks };
}
