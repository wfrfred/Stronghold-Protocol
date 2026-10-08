import { createWorldPosition } from "../geometry/coordinate.js";
import { copyUnitCapabilities } from "./capability/catalog.js";
import { ownUnitDefinition, type StableUnit, type Unit } from "./unit.js";

export type UnitSnapshot<U extends Unit> = U extends unknown
    ? Pick<StableUnit<U>, Extract<keyof U, keyof Unit>>
    : never;

export function copyUnitSnapshot<U extends Unit>(unit: U): UnitSnapshot<U>;
export function copyUnitSnapshot(unit: Readonly<Unit>): Unit {
    return {
        id: unit.id,
        definition: ownUnitDefinition(unit.definition),
        position: Object.isFrozen(unit.position)
            ? unit.position
            : createWorldPosition(...unit.position),
        ...copyUnitCapabilities(unit),
    };
}
