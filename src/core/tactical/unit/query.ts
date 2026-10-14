import type { BattlefieldView } from "../battlefield/contract.js";
import type { State as BattleState } from "../battle/state.js";
import type { Unit, Ref } from "./unit.js";

export interface Context {
    readonly unit: Unit;
    readonly battlefield: BattlefieldView;
}

/** Preserve the stable type of a known Unit without retaining its snapshot. */
export function ref<U extends Unit>(unit: U): Ref<U> {
    return { id: unit.id } as Ref<U>;
}

/** Select candidate identities in the battlefield's existing iteration order. */
export function filter<U extends Unit>(
    battle: BattleState,
    guard: (unit: Unit) => unit is U,
): Ref<U>[] {
    return [...battle.battlefield.units.values()].filter(guard).map(ref);
}

/** Read the current value; the identity and stable type are a caller contract. */
export function get<U extends Unit>(battle: BattleState, reference: Ref<U>): U | undefined {
    return battle.battlefield.units.get(reference.id) as U | undefined;
}
