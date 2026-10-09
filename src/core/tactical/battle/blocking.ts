import { acquireBlockingRelations } from "../battlefield/blocking/relations.js";
import type { BattlefieldChange, BattlefieldView } from "../battlefield/contract.js";
import type { Unit, UnitId } from "../unit/unit.js";

export function advanceBlocking(battlefield: BattlefieldView): readonly BattlefieldChange[] {
    const units = new Map<UnitId, Unit>(
        battlefield.unitIds.map((id) => [id, battlefield.getUnit(id)!]),
    );
    const relations = acquireBlockingRelations(
        battlefield.map,
        units,
        battlefield.blockingRelations,
        battlefield.supportRelations,
    );

    return relations === battlefield.blockingRelations
        ? []
        : [{ type: "SET_BLOCKING_RELATIONS", relations }];
}
