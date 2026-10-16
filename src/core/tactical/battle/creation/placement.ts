import type { BattlefieldChange } from "../../battlefield/contract.js";
import type {
    NavigationModifierDefinition,
    NavigationModifierSource,
} from "../../battlefield/navigation/modifier.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import { Direction } from "../../geometry/direction.js";
import { RangeGrid } from "../../geometry/range.js";
import * as initialization from "../../unit/initialize.js";
import type { Product } from "../../unit/capability/catalog.js";
import type { Unit, Definition } from "../../unit/unit.js";
import type { ImmutableData } from "../../../common/immutable-data.js";
import type { Effects } from "../../unit/effect/effects.js";
import {
    hasOccupancy,
    validateState as validateOccupancy,
    type Occupancy,
    type OccupancyClaim,
} from "../../unit/capability/occupancy/capability.js";
import type { Result, State as BattleState } from "../state.js";

export interface UnitNavigationModifierPlacement {
    readonly definition: NavigationModifierDefinition;
    readonly range: RangeGrid;
    readonly direction: Direction;
}

export interface UnitPlacementDefinition<D extends Definition = Definition> {
    readonly definition: D;
    readonly position: WorldPosition;
    readonly navigationModifiers?: readonly UnitNavigationModifierPlacement[];
    readonly claims?: readonly OccupancyClaim[];
    readonly effects?: Effects;
}

export interface UnitPlacementInstantiation<U extends Unit = Unit> {
    readonly unit: U;
    readonly changes: readonly BattlefieldChange[];
}

type NormalizedUnitPlacement<P extends UnitPlacementDefinition> = P extends unknown
    ? {
          readonly definition: ImmutableData<P["definition"]>;
          readonly position: WorldPosition;
          readonly navigationModifiers: readonly UnitNavigationModifierPlacement[];
          readonly effects?: Effects;
          readonly claims?: readonly OccupancyClaim[];
      }
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
                definition: navigationModifier.definition,
                range: RangeGrid.create(navigationModifier.range),
                direction: navigationModifier.direction,
            }),
        );
    }

    return Object.freeze({
        definition: placement.definition,
        ...(placement.claims === undefined ? {} : { claims: placement.claims }),
        position: placement.position,
        ...(placement.effects === undefined ? {} : { effects: placement.effects }),
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
    battle: BattleState,
    placement: P,
): Result<UnitPlacementInstantiation<Unit & Product<P["definition"]>>>;
export function instantiateUnitPlacement(
    battle: BattleState,
    placement: UnitPlacementDefinition,
): Result<UnitPlacementInstantiation> {
    const id = battle.execution.nextUnitId;
    const nextUnitId = nextIdentity(id, "unit");
    battle = { ...battle, execution: { ...battle.execution, nextUnitId } };
    const initialized = initialization.initialize(battle, {
        id,
        definition: placement.definition,
        position: placement.position,
        ...(placement.effects === undefined ? {} : { effects: placement.effects }),
    });
    battle = initialized.state;
    let unit: Unit = initialized.value;

    if (placement.claims !== undefined) {
        if (!hasOccupancy(unit)) {
            throw new TypeError("unit placement claims require occupancy capability");
        }

        const occupancy = { claims: placement.claims };
        validateOccupancy(occupancy);
        const occupied: Unit & Occupancy = { ...unit, occupancy };
        unit = occupied;
    }

    const changes: BattlefieldChange[] = [{ type: "REGISTER_UNIT", unit }];
    const source: NavigationModifierSource = Object.freeze({ type: "UNIT", unitId: unit.id });
    let nextNavigationModifierId = battle.execution.nextNavigationModifierId;

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
        state: { ...battle, execution: { ...battle.execution, nextNavigationModifierId } },
        value: { unit, changes },
    };
}
