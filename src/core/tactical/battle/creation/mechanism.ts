import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { BattlefieldChange } from "../../battlefield/contract.js";
import {
    createMechanismRuntime,
    type MechanismDefinition,
    type MechanismRuntime,
} from "../../battlefield/mechanism.js";
import type { BattleExecutionState } from "../execution/state.js";

export interface MechanismPlacementDefinition<D extends MechanismDefinition = MechanismDefinition> {
    readonly definition: D;
    readonly active?: boolean;
}

export interface MechanismPlacementInstantiation {
    readonly mechanism: MechanismRuntime;
    readonly execution: BattleExecutionState;
    readonly changes: readonly BattlefieldChange[];
}

export function instantiateMechanismPlacement(
    placement: MechanismPlacementDefinition,
    execution: BattleExecutionState,
): MechanismPlacementInstantiation {
    assertNonnegativeSafeInteger(execution.nextMechanismId, "mechanism id");

    const nextMechanismId = execution.nextMechanismId + 1;

    if (!Number.isSafeInteger(nextMechanismId)) {
        throw new RangeError("mechanism identity overflow");
    }

    const mechanism = createMechanismRuntime({
        id: execution.nextMechanismId,
        definition: placement.definition,
        active: placement.active ?? true,
    });

    return {
        mechanism,
        execution: { ...execution, nextMechanismId },
        changes: [{ type: "REGISTER_MECHANISM", mechanism }],
    };
}
