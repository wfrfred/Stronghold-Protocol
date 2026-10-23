import type { WorldPosition } from "../../geometry/coordinate.js";
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

export interface UnitPlacementDefinition<D extends Definition = Definition> {
    readonly definition: D;
    readonly position: WorldPosition;
    readonly claims?: readonly OccupancyClaim[];
    readonly effects?: Effects;
}

type NormalizedUnitPlacement<P extends UnitPlacementDefinition> = P extends unknown
    ? {
          readonly definition: ImmutableData<P["definition"]>;
          readonly position: WorldPosition;
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
    return Object.freeze({
        definition: placement.definition,
        ...(placement.claims === undefined ? {} : { claims: placement.claims }),
        position: placement.position,
        ...(placement.effects === undefined ? {} : { effects: placement.effects }),
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
): Result<Unit & Product<P["definition"]>>;
export function instantiateUnitPlacement(
    battle: BattleState,
    placement: UnitPlacementDefinition,
): Result<Unit> {
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

    return {
        state: battle,
        value: unit,
    };
}
