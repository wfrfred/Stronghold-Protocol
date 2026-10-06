import { acquireBlockingRelations } from "../battlefield/blocking.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { BattlePhase } from "./system.js";

export function createBlockingSystem(): { readonly step: BattlePhase } {
    const step: BattlePhase = (input) => {
        const units = new Map<UnitId, Unit>(
            input.battlefield.unitIds.map((id) => [id, input.battlefield.getUnit(id)!]),
        );
        const relations = acquireBlockingRelations(units, input.battlefield.blockingRelations);

        return {
            state: undefined,
            changes:
                relations === input.battlefield.blockingRelations
                    ? []
                    : [{ type: "SET_BLOCKING_RELATIONS", relations }],
            events: [],
            execution: input.execution,
        };
    };

    return { step };
}
