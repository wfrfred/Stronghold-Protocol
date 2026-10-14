import type { State as BattleState } from "../../../../battle/state.js";
import * as hook from "../../../hook/hook.js";
import type { State } from "../capability.js";
import type { Context as VitalityContext, Result } from "../hook.js";
import type { HealingReport, HealingRequest, PendingHealing } from "./contract.js";

export type Context = VitalityContext<HealingRequest>;

export type Stage = "output" | "reception" | "skippedReception";

export interface AmountHook extends hook.Hook<
    BattleState,
    Context,
    PendingHealing,
    Result<PendingHealing>
> {
    readonly stage: Stage;
    readonly priority: number;
}

export interface ReactionHook extends hook.Hook<
    BattleState,
    Context,
    HealingReport,
    undefined | { readonly stopDispatch?: boolean }
> {
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
