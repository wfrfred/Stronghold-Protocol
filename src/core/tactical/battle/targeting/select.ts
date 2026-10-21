import type { Ref } from "../../../common/ref.js";
import { hasTargetable, type Targetable } from "../../unit/capability/targetable/capability.js";
import type { Unit } from "../../unit/unit.js";
import type { State as BattleState, Result } from "../state.js";
import type { Request } from "./contract.js";

function* candidates(battle: BattleState, request: Request): IterableIterator<Unit & Targetable> {
    for (const target of battle.battlefield.units.values()) {
        if (hasTargetable(target) && request.filter(battle, request, target)) {
            yield target;
        }
    }
}

export function hasCandidate(battle: BattleState, request: Request): boolean {
    return !candidates(battle, request).next().done;
}

export function select(
    battle: BattleState,
    request: Request,
): Result<readonly Ref<Unit & Targetable>[]> {
    const accepted = [...candidates(battle, request)];

    return request.selector(battle, request, accepted);
}
