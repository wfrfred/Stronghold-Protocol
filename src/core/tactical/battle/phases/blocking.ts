import { acquireBlockingRelations } from "../../battlefield/blocking/relations.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { BattlePhaseInput, BattlePhaseOutput } from "../phase.js";

export function advanceBlocking(input: BattlePhaseInput): BattlePhaseOutput {
    const units = new Map<UnitId, Unit>(
        input.battlefield.unitIds.map((id) => [id, input.battlefield.getUnit(id)!]),
    );
    const relations = acquireBlockingRelations(
        input.battlefield.map,
        units,
        input.battlefield.blockingRelations,
        input.battlefield.supportRelations,
    );

    return {
        changes:
            relations === input.battlefield.blockingRelations
                ? []
                : [{ type: "SET_BLOCKING_RELATIONS", relations }],
        events: [],
        execution: input.execution,
    };
}
