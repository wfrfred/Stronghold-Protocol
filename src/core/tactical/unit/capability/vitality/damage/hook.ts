import { widenUnit, type Unit, type UnitId, type StableUnit } from "../../../unit.js";
import * as hook from "../../../hook/hook.js";
import type { BattleState } from "../../../../battle/execution/context.js";
import type { Vitality } from "../capability.js";
import type { Context as VitalityContext, Result, Services as VitalityServices } from "../hook.js";
import type { DamageOperands, DamageReport, DamageRequest, PendingDamage } from "./contract.js";

export type Context = VitalityContext<DamageRequest>;

export interface Services extends VitalityServices {
    readonly retireUnit: (battle: BattleState, unitId: UnitId, tick: number) => void;
}

export type FormulaStage = "sourceFormula" | "targetFormula";

export type AmountStage = "output" | "reception" | "skippedReception";

export interface FormulaHook extends hook.Hook<Context, DamageOperands, Result<DamageOperands>> {
    readonly stage: FormulaStage;
    readonly priority: number;
}

export interface AmountHook extends hook.Hook<Context, PendingDamage, Result<PendingDamage>> {
    readonly stage: AmountStage;
    readonly priority: number;
}

export interface ReactionHook extends hook.Hook<
    Context,
    DamageReport,
    undefined | { readonly stopDispatch?: boolean }
> {
    readonly stage: "reaction";
    readonly priority: number;
}

export type Hook = FormulaHook | AmountHook | ReactionHook;

export function setHook<U extends Unit & Vitality>(
    input: U | StableUnit<U>,
    entry: Hook,
): StableUnit<U> {
    const unit = widenUnit<U>(input);
    const damageHooks = hook.set(unit.vitality.damageHooks, entry);

    return damageHooks === unit.vitality.damageHooks
        ? unit
        : widenUnit<U>({ ...unit, vitality: { ...unit.vitality, damageHooks } });
}

export function removeHook<U extends Unit & Vitality>(
    input: U | StableUnit<U>,
    id: string,
): StableUnit<U> {
    const unit = widenUnit<U>(input);
    const damageHooks = hook.remove(unit.vitality.damageHooks, id);

    return damageHooks === unit.vitality.damageHooks
        ? unit
        : widenUnit<U>({ ...unit, vitality: { ...unit.vitality, damageHooks } });
}
