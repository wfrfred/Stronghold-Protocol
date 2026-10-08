import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { BattlefieldChange } from "../../battlefield/contract.js";
import type { MechanismId } from "../../battlefield/mechanism.js";
import {
    createNavigationModifier,
    type NavigationModifier,
    type NavigationModifierDefinition,
    type NavigationModifierRegion,
    type NavigationModifierSource,
} from "../../battlefield/navigation/modifier.js";
import type { Direction } from "../../geometry/direction.js";
import { RangeGrid } from "../../geometry/range.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattleExecutionState } from "../execution/state.js";

export type NavigationModifierPlacementSource =
    | { readonly type: "UNIT"; readonly unitIndex: number }
    | { readonly type: "MECHANISM"; readonly mechanismIndex: number };

export type NavigationModifierPlacementRegion =
    | Extract<NavigationModifierRegion, { readonly type: "FIXED" }>
    | {
          readonly type: "FOLLOW_UNIT";
          readonly unitIndex: number;
          readonly range: RangeGrid;
          readonly direction: Direction;
      };

export interface NavigationModifierPlacementDefinition {
    readonly definition: NavigationModifierDefinition;
    readonly source: NavigationModifierPlacementSource;
    readonly region: NavigationModifierPlacementRegion;
    readonly active?: boolean;
    readonly expiresAtTick?: number | null;
}

export interface NavigationModifierPlacementInstantiation {
    readonly modifier: NavigationModifier;
    readonly execution: BattleExecutionState;
    readonly changes: readonly BattlefieldChange[];
}

function initialIdentity(index: number, ids: readonly number[], name: string): number {
    assertNonnegativeSafeInteger(index, `${name} index`);

    const id = ids[index];

    if (!Object.hasOwn(ids, index) || id === undefined) {
        throw new RangeError(`unknown initial ${name} index: ${index}`);
    }

    assertNonnegativeSafeInteger(id, `${name} id`);

    return id;
}

export function instantiateNavigationModifierPlacement(
    placement: NavigationModifierPlacementDefinition,
    execution: BattleExecutionState,
    initialUnitIds: readonly UnitId[] = [],
    initialMechanismIds: readonly MechanismId[] = [],
): NavigationModifierPlacementInstantiation {
    assertNonnegativeSafeInteger(execution.nextNavigationModifierId, "navigation modifier id");

    const nextNavigationModifierId = execution.nextNavigationModifierId + 1;

    if (!Number.isSafeInteger(nextNavigationModifierId)) {
        throw new RangeError("navigation modifier identity overflow");
    }

    const source: NavigationModifierSource =
        placement.source.type === "UNIT"
            ? {
                  type: "UNIT",
                  unitId: initialIdentity(placement.source.unitIndex, initialUnitIds, "unit"),
              }
            : {
                  type: "MECHANISM",
                  mechanismId: initialIdentity(
                      placement.source.mechanismIndex,
                      initialMechanismIds,
                      "mechanism",
                  ),
              };
    const region: NavigationModifierRegion =
        placement.region.type === "FIXED"
            ? placement.region
            : {
                  type: "FOLLOW_UNIT",
                  unitId: initialIdentity(
                      placement.region.unitIndex,
                      initialUnitIds,
                      "followed unit",
                  ),
                  range: placement.region.range,
                  direction: placement.region.direction,
              };
    const modifier = createNavigationModifier({
        id: execution.nextNavigationModifierId,
        definition: placement.definition,
        source,
        region,
        active: placement.active ?? true,
        expiresAtTick: placement.expiresAtTick ?? null,
    });

    return {
        modifier,
        execution: { ...execution, nextNavigationModifierId },
        changes: [{ type: "ADD_NAVIGATION_MODIFIER", navigationModifier: modifier }],
    };
}
