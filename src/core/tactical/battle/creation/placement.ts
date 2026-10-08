import type { BattlefieldChange } from "../../battlefield/contract.js";
import type {
    NavigationModifierDefinition,
    NavigationModifierSource,
} from "../../battlefield/navigation/modifier.js";
import { createWorldPosition, type WorldPosition } from "../../geometry/coordinate.js";
import { Direction } from "../../geometry/direction.js";
import { RangeGrid } from "../../geometry/range.js";
import { initializeUnit, type InitializedUnit } from "../../unit/initialize.js";
import { ownUnitDefinition, type Unit, type UnitDefinition } from "../../unit/unit.js";
import { ownDataRecord, type ImmutableData } from "../../../common/immutable-data.js";
import {
    copyPreparedCapabilityStates,
    type CapabilityStates,
    type CopiedCapabilityStates,
    type PreparedCapabilityStates,
} from "../../unit/capability/catalog.js";
import type { BattleExecutionState } from "../execution/state.js";

export interface UnitNavigationModifierPlacement {
    readonly definition: NavigationModifierDefinition;
    readonly range: RangeGrid;
    readonly direction: Direction;
}

export interface UnitPlacementDefinition<D extends UnitDefinition = UnitDefinition> {
    readonly definition: D;
    readonly position: WorldPosition;
    readonly navigationModifiers?: readonly UnitNavigationModifierPlacement[];
    readonly states?: Partial<CapabilityStates>;
}

export interface UnitPlacementInstantiation<U extends Unit = Unit> {
    readonly unit: U;
    readonly execution: BattleExecutionState;
    readonly changes: readonly BattlefieldChange[];
}

type PlacedUnit<P extends UnitPlacementDefinition> = P extends unknown
    ? InitializedUnit<
          P["definition"],
          P extends { readonly states: infer S extends object } ? S : object
      >
    : never;

type NormalizedUnitPlacement<P extends UnitPlacementDefinition> = P extends unknown
    ? {
          readonly definition: ImmutableData<P["definition"]>;
          readonly position: WorldPosition;
          readonly navigationModifiers: readonly UnitNavigationModifierPlacement[];
      } & (P extends { readonly states: infer S extends object }
          ? { readonly states: CopiedCapabilityStates<S> }
          : "states" extends keyof P
            ? Pick<UnitPlacementDefinition, "states">
            : object)
    : never;

export function createUnitPlacementDefinition<P extends UnitPlacementDefinition>(
    placement: P,
): NormalizedUnitPlacement<P>;
export function createUnitPlacementDefinition(
    placement: UnitPlacementDefinition,
): NormalizedUnitPlacement<UnitPlacementDefinition> {
    const navigationModifiers: UnitNavigationModifierPlacement[] = [];
    const contributions = placement.navigationModifiers ?? [];

    for (let index = 0; index < contributions.length; index++) {
        const navigationModifier = contributions[index];

        if (!Object.hasOwn(contributions, index) || navigationModifier === undefined) {
            throw new TypeError(`missing unit navigation modifier at index ${index}`);
        }

        navigationModifiers.push(
            Object.freeze({
                definition: ownDataRecord(
                    navigationModifier.definition,
                    "navigation modifier definition",
                ),
                range: RangeGrid.create(navigationModifier.range),
                direction: navigationModifier.direction,
            }),
        );
    }

    return Object.freeze({
        definition: ownUnitDefinition(placement.definition),
        ...(placement.states === undefined
            ? {}
            : {
                  states: Object.freeze(copyPreparedCapabilityStates(placement.states)),
              }),
        position: createWorldPosition(...placement.position),
        navigationModifiers: Object.freeze(navigationModifiers),
    });
}

function nextIdentity(value: number, name: string): number {
    const next = value + 1;

    if (!Number.isSafeInteger(next)) {
        throw new RangeError(`${name} identity overflow`);
    }

    return next;
}

export function instantiateUnitPlacement<P extends UnitPlacementDefinition>(
    placement: P,
    execution: BattleExecutionState,
    tick: number,
): UnitPlacementInstantiation<PlacedUnit<P>>;
export function instantiateUnitPlacement(
    placement: UnitPlacementDefinition,
    execution: BattleExecutionState,
    tick: number,
): UnitPlacementInstantiation {
    const nextUnitId = nextIdentity(execution.nextUnitId, "unit");
    const unit = initializeUnit<UnitDefinition, PreparedCapabilityStates<UnitDefinition>>({
        id: execution.nextUnitId,
        definition: placement.definition,
        position: placement.position,
        tick,
        states: placement.states ?? {},
    });
    const changes: BattlefieldChange[] = [{ type: "REGISTER_UNIT", unit }];
    const source: NavigationModifierSource = Object.freeze({ type: "UNIT", unitId: unit.id });
    let nextNavigationModifierId = execution.nextNavigationModifierId;

    for (const contribution of placement.navigationModifiers ?? []) {
        const followingId = nextIdentity(nextNavigationModifierId, "navigation modifier");

        changes.push({
            type: "ADD_NAVIGATION_MODIFIER",
            navigationModifier: {
                id: nextNavigationModifierId,
                definition: contribution.definition,
                source,
                active: true,
                region: {
                    type: "FOLLOW_UNIT",
                    unitId: unit.id,
                    range: RangeGrid.create(contribution.range),
                    direction: contribution.direction,
                },
                expiresAtTick: null,
            },
        });
        nextNavigationModifierId = followingId;
    }

    return {
        unit,
        execution: { ...execution, nextUnitId, nextNavigationModifierId },
        changes,
    };
}
