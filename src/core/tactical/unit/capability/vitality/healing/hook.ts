import * as hook from "../../../hook/hook.js";
import type { State } from "../capability.js";
import type { Context as VitalityContext, Control } from "../hook.js";
import type { HealingReport, HealingRequest, PendingHealing } from "./contract.js";

export type Context = VitalityContext<HealingRequest>;

export type Stage = "output" | "reception" | "skippedReception";

export interface AmountHook extends hook.Hook<Context, PendingHealing & Control> {
    readonly stage: Stage;
    readonly priority: number;
}

export interface ReactionContext extends Context {
    readonly report: HealingReport;
}

export interface ReactionHook extends hook.Hook<ReactionContext, Control> {
    readonly stage: "reaction";
    readonly priority: number;
}

export type Hook = AmountHook | ReactionHook;

export function setHook(state: State, entry: Hook): State {
    const healingHooks = hook.set(state.healingHooks, entry);

    return healingHooks === state.healingHooks ? state : { ...state, healingHooks };
}

export function removeHook(state: State, id: string): State {
    const healingHooks = hook.remove(state.healingHooks, id);

    return healingHooks === state.healingHooks ? state : { ...state, healingHooks };
}
