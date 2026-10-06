import { createWorldPosition, type WorldPosition } from "../geometry/coordinate.js";
import {
    initializeUnitCapabilities,
    type PreparedCapabilityStates,
    type RuntimeCapabilitiesFor,
} from "./capability/catalog.js";
import type { Unit, UnitDefinition, UnitId } from "./unit.js";

export interface UnitInitialization<D extends UnitDefinition = UnitDefinition> {
    readonly id: UnitId;
    readonly definition: D;
    readonly position: WorldPosition;
    readonly tick?: number;
    readonly states?: never;
}

export type PreparedUnitInitialization<
    D extends UnitDefinition,
    S extends PreparedCapabilityStates<D>,
> = Omit<UnitInitialization<D>, "states"> & {
    readonly states: S & Record<Exclude<keyof S, keyof PreparedCapabilityStates<D>>, never>;
};

type RuntimeCapabilitiesWithStates<D extends UnitDefinition, S extends object> = {
    readonly [K in keyof RuntimeCapabilitiesFor<D>]: S extends Readonly<Record<K, unknown>>
        ? S[K]
        : RuntimeCapabilitiesFor<D>[K];
} & Omit<S, keyof RuntimeCapabilitiesFor<D>>;

export type InitializedUnit<D extends UnitDefinition, S extends object = object> = D extends unknown
    ? Unit<D> & RuntimeCapabilitiesWithStates<D, S>
    : never;

export function initializeUnit<D extends UnitDefinition>(
    input: UnitInitialization<D>,
): InitializedUnit<D>;
export function initializeUnit<D extends UnitDefinition, S extends PreparedCapabilityStates<D>>(
    prepared: PreparedUnitInitialization<D, S>,
): InitializedUnit<D, S>;
export function initializeUnit<D extends UnitDefinition>(
    input: Omit<UnitInitialization<D>, "states"> & { readonly states?: object },
): Unit<D> {
    const { id, definition, position } = input;
    const states = initializeUnitCapabilities(
        definition,
        { tick: input.tick ?? 0 },
        input.states ?? {},
    );

    return {
        id,
        definition,
        position: Object.isFrozen(position) ? position : createWorldPosition(...position),
        ...states,
    };
}
