import type { BattlefieldChange } from "../../battlefield/contract.js";
import type {
    NavigationEffectDefinition,
    SpatialEffectSource,
} from "../../battlefield/navigation/effect.js";
import { createWorldPosition, type WorldPosition } from "../../geometry/coordinate.js";
import { Direction } from "../../geometry/direction.js";
import { RangeGrid } from "../../geometry/range.js";
import {
    createOccupancyClaims,
    type Occupancy,
    type OccupancyState,
} from "../../unit/capability/occupancy.js";
import { initializeUnit, type InitializedUnit } from "../../unit/initialize.js";
import { ownUnitDefinition, type Unit, type UnitDefinition } from "../../unit/unit.js";
import type { ImmutableData } from "../../../common/immutable-data.js";
import {
    copyPreparedCapabilityStates,
    type CapabilityStates,
    type CopiedCapabilityStates,
    type PreparedCapabilityStates,
} from "../../unit/capability/catalog.js";
import type { BattleExecutionState } from "../execution/state.js";

export interface UnitNavigationEffectPlacement {
    readonly definition: NavigationEffectDefinition;
    readonly range: RangeGrid;
    readonly direction: Direction;
}

export interface UnitPlacementDefinition<D extends UnitDefinition = UnitDefinition> {
    readonly definition: D;
    readonly position: WorldPosition;
    readonly occupancy?: OccupancyState;
    readonly navigationEffects?: readonly UnitNavigationEffectPlacement[];
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
      > &
          (P extends { readonly occupancy: OccupancyState } ? Occupancy : object)
    : never;

type NormalizedUnitPlacement<P extends UnitPlacementDefinition> = P extends unknown
    ? {
          readonly definition: ImmutableData<P["definition"]>;
          readonly position: WorldPosition;
          readonly navigationEffects: readonly UnitNavigationEffectPlacement[];
      } & (P extends { readonly occupancy: OccupancyState }
          ? Occupancy
          : Pick<UnitPlacementDefinition, "occupancy">) &
          (P extends { readonly states: infer S extends object }
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
    assertSingleOccupancy(placement);

    const navigationEffects: UnitNavigationEffectPlacement[] = [];
    const effects = placement.navigationEffects ?? [];

    for (let index = 0; index < effects.length; index++) {
        const effect = effects[index];

        if (!Object.hasOwn(effects, index) || effect === undefined) {
            throw new TypeError(`missing unit navigation effect at index ${index}`);
        }

        navigationEffects.push(
            Object.freeze({
                definition: effect.definition,
                range: RangeGrid.create(effect.range),
                direction: effect.direction,
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
        ...(placement.occupancy === undefined
            ? {}
            : {
                  occupancy: Object.freeze({
                      claims: createOccupancyClaims(placement.occupancy.claims),
                  }),
              }),
        navigationEffects: Object.freeze(navigationEffects),
    });
}

function assertSingleOccupancy(placement: UnitPlacementDefinition): void {
    if (placement.occupancy !== undefined && placement.states?.occupancy !== undefined) {
        throw new TypeError("unit occupancy must have a single initial state");
    }
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
    assertSingleOccupancy(placement);

    const nextUnitId = nextIdentity(execution.nextUnitId, "unit");
    const prepared = placement.states ?? {};
    const states =
        placement.occupancy === undefined
            ? prepared
            : { ...prepared, occupancy: placement.occupancy };
    const unit = initializeUnit<UnitDefinition, PreparedCapabilityStates<UnitDefinition>>({
        id: execution.nextUnitId,
        definition: placement.definition,
        position: placement.position,
        tick,
        states,
    });
    const changes: BattlefieldChange[] = [{ type: "REGISTER_UNIT", unit }];
    const source: SpatialEffectSource = Object.freeze({ type: "UNIT", unitId: unit.id });
    let nextSpatialEffectId = execution.nextSpatialEffectId;

    for (const contribution of placement.navigationEffects ?? []) {
        const followingId = nextIdentity(nextSpatialEffectId, "spatial effect");

        changes.push({
            type: "ADD_EFFECT",
            effect: {
                id: nextSpatialEffectId,
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
        nextSpatialEffectId = followingId;
    }

    return {
        unit,
        execution: { ...execution, nextUnitId, nextSpatialEffectId },
        changes,
    };
}
