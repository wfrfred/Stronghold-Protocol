import { endDependents } from "../../unit/effect/operations.js";
import { key, type Lifetime } from "../../unit/effect/effect.js";
import { transitionUnit, type State as BattleState } from "../state.js";

export function closeLifetime(
    state: BattleState,
    lifetime: Lifetime,
    reason = "SCOPE_CLOSED",
): BattleState {
    if (lifetime.type === "UNIT") {
        state = transitionUnit(state, lifetime.unitId, (unit) =>
            unit.lifecycle === "LEAVING" ? unit : { ...unit, lifecycle: "LEAVING" },
        );
    } else {
        state = {
            ...state,
            closedLifetimes: new Set([...state.closedLifetimes, key(lifetime)]),
        };
    }

    return endDependents(state, lifetime, reason);
}
