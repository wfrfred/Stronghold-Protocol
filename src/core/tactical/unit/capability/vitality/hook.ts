import type { Unit, UnitId } from "../../unit.js";
import { getUnit, type BattleState } from "../../../battle/execution/context.js";
import type { Vitality } from "./capability.js";
import type { Hook as DamageHook } from "./damage/hook.js";
import type { Hook as HealingHook } from "./healing/hook.js";
import type { DamageOperation, DamageReport, DamageRequest } from "./damage/contract.js";
import type { HealingOperation, HealingReport, HealingRequest } from "./healing/contract.js";

export interface Result<V> {
    readonly value: V;
    readonly stopDispatch?: boolean;
}

export interface Operations {
    damage(request: Omit<DamageRequest, "tick">): DamageReport;
    heal(request: Omit<HealingRequest, "tick">): HealingReport;
}

export interface Context<R> {
    readonly battle: BattleState;
    readonly unit: Unit;
    readonly request: R;
    readonly tick: number;
    readonly operations: Operations;
}

export interface Services {
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}

interface Candidates {
    readonly damage: readonly DamageHook[];
    readonly healing: readonly HealingHook[];
}

export class Dispatch {
    readonly #candidates = new Map<UnitId, Candidates>();

    withCandidates<T>(unit: Unit & Vitality, run: (candidates: Candidates) => T): T {
        const existing = this.#candidates.get(unit.id);

        if (existing !== undefined) {
            return run(existing);
        }

        const candidates = {
            damage: unit.vitality.damageHooks,
            healing: unit.vitality.healingHooks,
        };
        this.#candidates.set(unit.id, candidates);

        try {
            return run(candidates);
        } finally {
            this.#candidates.delete(unit.id);
        }
    }
}

const activeDispatches = new WeakMap<BattleState, Dispatch>();

export function withDispatch<T>(
    battle: BattleState,
    requested: Dispatch | undefined,
    run: (dispatch: Dispatch) => T,
): T {
    const previous = activeDispatches.get(battle);
    const dispatch = requested ?? previous ?? new Dispatch();
    activeDispatches.set(battle, dispatch);

    try {
        return run(dispatch);
    } finally {
        if (previous === undefined) {
            activeDispatches.delete(battle);
        } else {
            activeDispatches.set(battle, previous);
        }
    }
}

export function context<R extends { readonly tick: number }>(
    battle: BattleState,
    unitId: UnitId,
    request: R,
    services: Services,
    dispatch: Dispatch,
): Context<R> {
    return {
        battle,
        get unit() {
            return getUnit(battle, unitId)!;
        },
        request,
        tick: request.tick,
        operations: {
            damage: (input) =>
                services.settleDamage(battle, { ...input, tick: request.tick }, dispatch),
            heal: (input) =>
                services.settleHealing(battle, { ...input, tick: request.tick }, dispatch),
        },
    };
}
