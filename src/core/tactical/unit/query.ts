import type { BattlefieldView } from "../battlefield/contract.js";
import type { State as BattleState } from "../battle/state.js";
import type { Unit, Ref } from "./unit.js";

export interface Context {
    readonly unit: Unit;
    readonly battlefield: BattlefieldView;
}

export function ref<U extends Unit>(unit: U): Ref<U> {
    return { id: unit.id } as Ref<U>;
}

export function all(battle: BattleState): Ref[] {
    return [...battle.battlefield.units.values()].map(ref);
}

export function filter<U extends Unit>(
    battle: BattleState,
    guard: (unit: Unit) => unit is U,
): Ref<U>[] {
    return [...battle.battlefield.units.values()].filter(guard).map(ref);
}

export function get<U extends Unit>(battle: BattleState, reference: Ref<U>): U | undefined {
    return battle.battlefield.units.get(reference.id) as U | undefined;
}
