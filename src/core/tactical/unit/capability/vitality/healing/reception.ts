import type { CombatTargetingView } from "../../../targeting/query.js";
import type { Unit } from "../../../unit.js";
import { hasVitality } from "../capability.js";
import type { HealingCancellation, HealingRequest } from "./contract.js";

export interface Context {
    readonly source: Unit | undefined;
    readonly target: Unit;
    readonly battlefield: CombatTargetingView;
    readonly ignoreHealFree: boolean;
    readonly request?: HealingRequest;
}

export interface Rule {
    readonly id: string;
    readonly cancel: (context: Context) => HealingCancellation | null;
}

export function receptionCancellation(context: Context): HealingCancellation | null {
    if (!hasVitality(context.target)) {
        return { reason: "NO_VITALITY" };
    }
    if (context.target.vitality.hp <= 0) {
        return { reason: "TARGET_DEAD" };
    }

    for (const rule of context.target.vitality.healingReceptionRules) {
        const cancellation = rule.cancel(context);

        if (cancellation !== null) {
            return cancellation;
        }
    }

    return null;
}

export function canReceiveHealing(context: Context): boolean {
    return receptionCancellation(context) === null;
}
