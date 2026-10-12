import { selectCapabilityStates } from "./capability/catalog.js";
import type { Unit } from "./unit.js";

export type UnitSnapshot<U extends Unit> = U extends unknown
    ? Pick<U, Extract<keyof U, keyof Unit>>
    : never;

export function copyUnitSnapshot<U extends Unit>(unit: U): UnitSnapshot<U>;
export function copyUnitSnapshot(unit: Readonly<Unit>): Unit {
    return {
        id: unit.id,
        lifecycle: unit.lifecycle,
        definition: unit.definition,
        position: unit.position,
        effects: unit.effects,
        ...selectCapabilityStates(unit),
    };
}
