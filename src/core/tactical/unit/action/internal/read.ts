import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState } from "../../../battle/state.js";
import type { Action } from "../../capability/action/capability.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import type { Id } from "../definition.js";
import type { State } from "../state.js";

export function read<R>(
    battle: BattleState,
    source: Ref<Unit & Action>,
    id: Id,
    reader: <P extends object, E extends object>(self: State<P, E>) => R,
): R | undefined {
    return units.get(battle, source)?.action.states.read(id, reader);
}
