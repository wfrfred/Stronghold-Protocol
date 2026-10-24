import type { State as BattleState } from "../battle/state.js";
import type { Unit } from "./unit.js";
import type { Ref } from "../../common/ref.js";
import { create, type Query } from "../../common/query.js";

export function ref<U extends Unit>(unit: U): Ref<U> {
    return { id: unit.id } as Ref<U>;
}

export function all(battle: BattleState): Query<Unit> {
    return create(() => battle.battlefield.units.values());
}

export function get<U extends Unit>(battle: BattleState, reference: Ref<U>): U | undefined {
    return battle.battlefield.units.get(reference.id) as U | undefined;
}
