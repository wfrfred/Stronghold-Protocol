import { initializers, type States } from "./capability/catalog.js";
import type { Unit } from "./unit.js";

export type Snapshot<U extends Unit> = U extends unknown
    ? Pick<U, Extract<keyof U, keyof Unit | keyof States>>
    : never;

export function selectStates<S extends object>(source: S): Pick<S, Extract<keyof S, keyof States>>;
export function selectStates(source: object): object {
    const states: Record<string, unknown> = {};

    for (const key of Object.keys(initializers)) {
        const state: unknown = Reflect.get(source, key);

        if (state !== undefined) {
            states[key] = state;
        }
    }

    return states;
}

export function copy<U extends Unit>(unit: U): Snapshot<U>;
export function copy(unit: Unit): Unit {
    return {
        id: unit.id,
        lifecycle: unit.lifecycle,
        definition: unit.definition,
        position: unit.position,
        effects: unit.effects,
        ...selectStates(unit),
    };
}
