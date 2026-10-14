import type { CombatTargetingView } from "../../../targeting/query.js";
import type { Unit } from "../../../unit.js";
import type { Vitality } from "../capability.js";
import type { DamageCancellation, DamageReceptionPolicy, DamageRequest } from "./contract.js";

export interface Context {
    readonly source: Unit | undefined;
    readonly target: Unit & Vitality;
    readonly battlefield: CombatTargetingView;
    readonly request: DamageRequest;
    readonly policy: DamageReceptionPolicy;
}

export interface Rule {
    readonly id: string;
    readonly cancel: (context: Context) => DamageCancellation | null;
}

export function receptionCancellation(context: Context): DamageCancellation | null {
    for (const rule of context.target.vitality.damageReceptionRules) {
        const cancellation = rule.cancel(context);

        if (cancellation !== null) {
            return cancellation;
        }
    }

    return null;
}
