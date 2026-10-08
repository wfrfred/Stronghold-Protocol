import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { BattlefieldChange } from "../../battlefield/contract.js";
import {
    createMechanismRuntime,
    type MechanismDefinition,
    type MechanismRuntime,
} from "../../battlefield/mechanism.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattleExecutionState } from "../execution/state.js";

export interface MechanismEffectSourcePlacementDefinition {
    readonly programRef: { readonly id: string };
    readonly state: object;
    readonly sourceUnitIndex?: number;
}

export interface MechanismPlacementDefinition<D extends MechanismDefinition = MechanismDefinition> {
    readonly definition: D;
    readonly active?: boolean;
    readonly effectSource?: MechanismEffectSourcePlacementDefinition;
}

export interface MechanismPlacementInstantiation {
    readonly mechanism: MechanismRuntime;
    readonly execution: BattleExecutionState;
    readonly changes: readonly BattlefieldChange[];
}

function sourceUnitId(index: number, initialUnitIds: readonly UnitId[]): UnitId {
    assertNonnegativeSafeInteger(index, "effect source unit index");

    const id = initialUnitIds[index];

    if (!Object.hasOwn(initialUnitIds, index) || id === undefined) {
        throw new RangeError(`unknown initial unit index: ${index}`);
    }

    assertNonnegativeSafeInteger(id, "effect source unit id");

    return id;
}

export function instantiateMechanismPlacement(
    placement: MechanismPlacementDefinition,
    execution: BattleExecutionState,
    initialUnitIds: readonly UnitId[] = [],
): MechanismPlacementInstantiation {
    assertNonnegativeSafeInteger(execution.nextMechanismId, "mechanism id");

    const nextMechanismId = execution.nextMechanismId + 1;

    if (!Number.isSafeInteger(nextMechanismId)) {
        throw new RangeError("mechanism identity overflow");
    }

    const effectSource = placement.effectSource;
    const base = {
        id: execution.nextMechanismId,
        definition: placement.definition,
        active: placement.active ?? true,
    };
    const mechanism =
        effectSource === undefined
            ? createMechanismRuntime(base)
            : createMechanismRuntime({
                  ...base,
                  effectSource: {
                      programRef: effectSource.programRef,
                      sourceUnitId:
                          effectSource.sourceUnitIndex === undefined
                              ? null
                              : sourceUnitId(effectSource.sourceUnitIndex, initialUnitIds),
                      state: effectSource.state,
                      receivers: [],
                      initialized: false,
                      finished: false,
                  },
              });

    return {
        mechanism,
        execution: { ...execution, nextMechanismId },
        changes: [{ type: "REGISTER_MECHANISM", mechanism }],
    };
}
