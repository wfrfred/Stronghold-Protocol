import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import {
    skillSpCapacity,
    type SkillDefinition,
    type SkillSpRecovery,
    type SkillState,
} from "./capability.js";

export type SkillSpSource = Exclude<SkillSpRecovery, "NONE"> | "EXTERNAL";

export type SkillSpResult =
    | { readonly type: "APPLIED"; readonly amount: number }
    | {
          readonly type: "REJECTED";
          readonly reason: "LOCKED" | "WRONG_SOURCE" | "FULL" | "INSUFFICIENT_SP";
      };

export interface SkillSpTransition {
    readonly state: SkillState;
    readonly result: SkillSpResult;
}

export function gainSkillSp(
    state: SkillState,
    definition: SkillDefinition,
    source: SkillSpSource,
    amount = 1,
): SkillSpTransition {
    assertNonnegativeSafeInteger(amount, "skill SP gain");

    if (state.active !== null) {
        return { state, result: { type: "REJECTED", reason: "LOCKED" } };
    }
    if (source !== "EXTERNAL" && source !== definition.spRecovery) {
        return { state, result: { type: "REJECTED", reason: "WRONG_SOURCE" } };
    }

    const gained = Math.min(amount, Math.max(0, skillSpCapacity(definition) - state.sp));

    if (gained === 0 && amount !== 0) {
        return { state, result: { type: "REJECTED", reason: "FULL" } };
    }

    return {
        state: gained === 0 ? state : { ...state, sp: state.sp + gained },
        result: { type: "APPLIED", amount: gained },
    };
}

export function spendSkillSp(
    state: SkillState,
    definition: SkillDefinition,
    amount = definition.spCost,
): SkillSpTransition {
    assertNonnegativeSafeInteger(amount, "skill SP spending");

    if (state.active !== null) {
        return { state, result: { type: "REJECTED", reason: "LOCKED" } };
    }
    if (state.sp < amount) {
        return { state, result: { type: "REJECTED", reason: "INSUFFICIENT_SP" } };
    }

    return {
        state: amount === 0 ? state : { ...state, sp: state.sp - amount },
        result: { type: "APPLIED", amount },
    };
}

export function drainSkillSp(
    state: SkillState,
    amount: number,
): {
    readonly state: SkillState;
    readonly result: { readonly type: "APPLIED"; readonly amount: number };
} {
    assertNonnegativeSafeInteger(amount, "skill external SP drain");
    const drained = Math.min(state.sp, amount);

    return {
        state: drained === 0 ? state : { ...state, sp: state.sp - drained },
        result: { type: "APPLIED", amount: drained },
    };
}
