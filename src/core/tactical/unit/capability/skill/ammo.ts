import { assertPositiveSafeInteger } from "../../../../common/assert.js";
import type { SkillState } from "./capability.js";

export type SkillAmmoResult =
    | { readonly type: "APPLIED"; readonly amount: number; readonly remainingAmmo: number }
    | { readonly type: "REJECTED"; readonly reason: "INACTIVE" | "NO_AMMO" };

export interface SkillAmmoSpending {
    readonly state: SkillState;
    readonly result: SkillAmmoResult;
}

export function spendSkillAmmo(state: SkillState, amount = 1): SkillAmmoSpending {
    assertPositiveSafeInteger(amount, "skill ammunition consumption");
    const { active } = state;

    if (active === null) {
        return { state, result: { type: "REJECTED", reason: "INACTIVE" } };
    }
    if (active.remainingAmmo === undefined) {
        return { state, result: { type: "REJECTED", reason: "NO_AMMO" } };
    }

    const spent = Math.min(active.remainingAmmo, amount);
    const remainingAmmo = active.remainingAmmo - spent;

    return {
        state: spent === 0 ? state : { ...state, active: { ...active, remainingAmmo } },
        result: { type: "APPLIED", amount: spent, remainingAmmo },
    };
}
