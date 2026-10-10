import { selectCapabilityStates } from "./capability/catalog.js";
import type { StableUnit, Unit } from "./unit.js";

export type UnitSnapshot<U extends Unit> = U extends unknown
    ? Pick<StableUnit<U>, Extract<keyof U, keyof Unit>>
    : never;

export function copyUnitSnapshot<U extends Unit>(unit: U): UnitSnapshot<U>;
export function copyUnitSnapshot(unit: Readonly<Unit>): Unit {
    return {
        id: unit.id,
        definition: unit.definition,
        position: unit.position,
        ...selectCapabilityStates(unit),
    };
}
