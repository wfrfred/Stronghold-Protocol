import { endDependents } from "../../unit/effect/operations.js";
import type { Lifetime } from "../../unit/effect/effect.js";
import { transitionUnit, type State as BattleState } from "../state.js";

export function closeLifetime(
    state: BattleState,
    lifetime: Lifetime,
    reason = "SCOPE_CLOSED",
): BattleState {
    if (lifetime.type === "UNIT") {
        state = transitionUnit(state, lifetime.ref.id, (unit) =>
            unit.lifecycle === "LEAVING" ? unit : { ...unit, lifecycle: "LEAVING" },
        );
    }

    return endDependents(state, lifetime, reason);
}
