import { getUnit, type BattleState } from "../../../battle/execution/context.js";
import type { EndContext } from "../definition.js";
import type { Effect, Ref, Value } from "../effect.js";
import { end, setState } from "../operations.js";
import { get } from "../query.js";

export function invoke(
    battle: BattleState,
    ref: Ref,
    instance: Value,
    event: "onApply" | "onEnable" | "onDisable" | "onTick" | "onEnd",
    reason = "EXPLICIT",
    host = getUnit(battle, ref.unitId)!,
): Value {
    let current = instance as Effect<object>;
    const context: EndContext<object> = {
        battle,
        tick: battle.tick,
        ref,
        reason,
        get unit() {
            return getUnit(battle, ref.unitId) ?? host;
        },
        get self() {
            current = (get(battle, ref) as Effect<object> | undefined) ?? current;

            return current;
        },
        setState(next) {
            setState(battle, ref, current.definition, next);
            current = (get(battle, ref) as Effect<object> | undefined) ?? current;
        },
        end(why) {
            current = (end(battle, ref, why) as Effect<object> | undefined) ?? current;
        },
    };

    current.definition[event]?.(context);

    return get(battle, ref) ?? current;
}
