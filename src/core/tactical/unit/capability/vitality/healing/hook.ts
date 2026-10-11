import { widenUnit, type Unit, type StableUnit } from "../../../unit.js";
import * as hook from "../../../hook/hook.js";
import type { Vitality } from "../capability.js";
import type { Context as VitalityContext, Result } from "../hook.js";
import type { HealingReport, HealingRequest, PendingHealing } from "./contract.js";

export type Context = VitalityContext<HealingRequest>;

export type Stage = "output" | "reception" | "skippedReception";

export interface AmountHook extends hook.Hook<Context, PendingHealing, Result<PendingHealing>> {
    readonly stage: Stage;
    readonly priority: number;
}

export interface ReactionHook extends hook.Hook<
    Context,
    HealingReport,
    undefined | { readonly stopDispatch?: boolean }
> {
    readonly stage: "reaction";
    readonly priority: number;
}

export type Hook = AmountHook | ReactionHook;

export function setHook<U extends Unit & Vitality>(
    input: U | StableUnit<U>,
    entry: Hook,
): StableUnit<U> {
    const unit = widenUnit<U>(input);
    const healingHooks = hook.set(unit.vitality.healingHooks, entry);

    return healingHooks === unit.vitality.healingHooks
        ? unit
        : widenUnit<U>({ ...unit, vitality: { ...unit.vitality, healingHooks } });
}

export function removeHook<U extends Unit & Vitality>(
    input: U | StableUnit<U>,
    id: string,
): StableUnit<U> {
    const unit = widenUnit<U>(input);
    const healingHooks = hook.remove(unit.vitality.healingHooks, id);

    return healingHooks === unit.vitality.healingHooks
        ? unit
        : widenUnit<U>({ ...unit, vitality: { ...unit.vitality, healingHooks } });
}
