import type { Ref } from "../../../../common/ref.js";
import { advanceBattlefield, type State as BattleState } from "../../../battle/state.js";
import type { WorldPosition } from "../../../geometry/coordinate.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import type { SpatialPresence } from "./capability.js";

export function disappear(battle: BattleState, ref: Ref<Unit & SpatialPresence>): BattleState {
    const unit = units.get(battle, ref);

    if (unit?.lifecycle !== "PRESENT") {
        return battle;
    }

    const next = { ...unit, spatialPresence: { present: false } };

    return advanceBattlefield(battle, [
        { type: "RELEASE_BLOCKING_RELATIONS", unitId: unit.id },
        { type: "UPDATE_UNIT", unit: next },
    ]);
}

export function appear(
    battle: BattleState,
    ref: Ref<Unit & SpatialPresence>,
    position: WorldPosition,
): BattleState {
    const unit = units.get(battle, ref);

    if (unit?.lifecycle !== "PRESENT") {
        return battle;
    }

    const next = { ...unit, position, spatialPresence: { present: true } };

    return advanceBattlefield(battle, [
        { type: "RELEASE_BLOCKING_RELATIONS", unitId: unit.id },
        { type: "UPDATE_UNIT", unit: next },
    ]);
}
