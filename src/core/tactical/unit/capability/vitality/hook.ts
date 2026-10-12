import type { Unit } from "../../unit.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type { CallContext } from "../../../battle/execution/call.js";

import type { Vitality } from "./capability.js";
import type { Hook as DamageHook } from "./damage/hook.js";
import type { Hook as HealingHook } from "./healing/hook.js";

export interface HookCandidates {
    readonly damage: readonly DamageHook[];
    readonly healing: readonly HealingHook[];
}

export function hookScope(
    unit: Unit & Vitality,
    call: CallContext,
): {
    readonly candidates: HookCandidates;
    readonly call: CallContext;
} {
    const previous = call.vitalitySnapshots?.get(unit.id);

    if (previous !== undefined) {
        return { candidates: previous, call };
    }

    const candidates: HookCandidates = {
        damage: unit.vitality.damageHooks,
        healing: unit.vitality.healingHooks,
    };

    return {
        candidates,
        call: {
            ...call,
            vitalitySnapshots: new Map([...(call.vitalitySnapshots ?? []), [unit.id, candidates]]),
        },
    };
}

export interface Result<V> {
    readonly value: V;
    readonly stopDispatch?: boolean;
}

export interface Context<R> {
    readonly unit: Unit;
    readonly battlefield: BattlefieldView;
    readonly request: R;
    readonly tick: number;
    readonly call: CallContext;
}
