import { selectCapabilityStates, type CapabilityStates } from "./capability/catalog.js";
import type { Unit } from "./unit.js";

export type Snapshot<U extends Unit> = U extends unknown
    ? Pick<U, Extract<keyof U, keyof Unit | keyof CapabilityStates>>
    : never;

export function copy<U extends Unit>(unit: U): Snapshot<U>;
export function copy(unit: Readonly<Unit>): Unit {
    return {
        id: unit.id,
        lifecycle: unit.lifecycle,
        definition: unit.definition,
        position: unit.position,
        effects: unit.effects,
        ...selectCapabilityStates(unit),
    };
}
