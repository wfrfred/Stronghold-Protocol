import type { Ref } from "../../../common/ref.js";
import { hasTargetable, type Targetable } from "../../unit/capability/targetable/capability.js";
import * as units from "../../unit/query.js";
import type { Unit } from "../../unit/unit.js";
import type { State as BattleState, Result } from "../state.js";
import type { Request } from "./contract.js";

export function hasCandidate(battle: BattleState, request: Request): boolean {
    return units
        .all(battle)
        .filter(hasTargetable)
        .some((target) => request.filter(battle, request, target));
}

export function select(
    battle: BattleState,
    request: Request,
): Result<readonly Ref<Unit & Targetable>[]> {
    const accepted = units
        .all(battle)
        .filter(hasTargetable)
        .filter((target) => request.filter(battle, request, target))
        .toArray();

    return request.selector(battle, request, accepted);
}
