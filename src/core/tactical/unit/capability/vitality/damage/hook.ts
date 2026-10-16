import * as hook from "../../../hook/hook.js";
import type { State } from "../capability.js";
import type { Context as VitalityContext, Control } from "../hook.js";
import type { DamageOperands, DamageReport, DamageRequest, PendingDamage } from "./contract.js";

export type Context = VitalityContext<DamageRequest>;

export type FormulaStage = "sourceFormula" | "targetFormula";

export type AmountStage = "output" | "reception" | "skippedReception";

export interface FormulaHook extends hook.Hook<Context, DamageOperands & Control> {
    readonly stage: FormulaStage;
    readonly priority: number;
}

export interface AmountHook extends hook.Hook<Context, PendingDamage & Control> {
    readonly stage: AmountStage;
    readonly priority: number;
}

export interface ReactionContext extends Context {
    readonly report: DamageReport;
}

export interface ReactionHook extends hook.Hook<ReactionContext, Control> {
    readonly stage: "reaction";
    readonly priority: number;
}

export interface Received {
    readonly request: DamageRequest;
    readonly pending: PendingDamage;
}

export interface ReceivedContext {
    readonly host: Context["host"];
    readonly event: Received;
}

export interface ReceivedHook extends hook.Hook<ReceivedContext, void> {
    readonly stage: "received";
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
