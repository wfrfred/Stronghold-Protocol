import { getUnit, type BattleState } from "../../battle/execution/context.js";
import type { Unit } from "../unit.js";
import type { Definition } from "./definition.js";
import type { Effect, Ref, Value } from "./effect.js";

export function get(battle: BattleState, ref: Ref): Value | undefined {
    return getUnit(battle, ref.unitId)?.effects.instances.find(
        (instance) => instance.id === ref.effectId,
    );
}

export function find<S extends object, H extends object>(
    unit: Unit,
    definition: Definition<S, H>,
    id: number,
): Effect<S, H> | undefined {
    const instance = unit.effects.instances.find(
        (instance) => instance.id === id && instance.definition === definition,
    );

    return instance as Effect<S, H> | undefined;
}
