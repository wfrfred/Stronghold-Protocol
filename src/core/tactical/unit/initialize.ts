import type { WorldPosition } from "../geometry/coordinate.js";
import {
    initializeUnitCapabilities,
    type SelectedCapabilityStates,
    type CapabilityStates,
    type PreparedCapabilityStates,
    type RuntimeCapabilitiesFor,
} from "./capability/catalog.js";
import type { Unit, Definition, Id } from "./unit.js";
import { Effects } from "./effect/effects.js";

export interface Input<D extends Definition = Definition> {
    readonly id: Id;
    readonly definition: D;
    readonly position: WorldPosition;
    readonly tick?: number;
    readonly effects?: Effects;
    readonly states?: never;
}

export type PreparedInput<D extends Definition, S extends PreparedCapabilityStates<D>> = Omit<
    Input<D>,
    "states"
> & {
    readonly states: S & Record<Exclude<keyof S, keyof PreparedCapabilityStates<D>>, never>;
};

type RuntimeCapabilitiesWithStates<D extends Definition, S extends object> = {
    readonly [K in keyof RuntimeCapabilitiesFor<D>]: S extends Readonly<Record<K, unknown>>
        ? SelectedCapabilityStates<S>[K & keyof SelectedCapabilityStates<S>]
        : RuntimeCapabilitiesFor<D>[K];
} & Omit<SelectedCapabilityStates<S>, keyof RuntimeCapabilitiesFor<D>>;

export type Result<D extends Definition, S extends object = object> = D extends unknown
    ? Unit<D> & RuntimeCapabilitiesWithStates<D, S>
    : never;

export function initialize<D extends Definition>(input: Input<D>): Result<D>;
export function initialize<D extends Definition, S extends PreparedCapabilityStates<D>>(
    prepared: PreparedInput<D, S>,
): Result<D, S>;
export function initialize<D extends Definition>(
    input: Omit<Input<D>, "states"> & { readonly states?: Partial<CapabilityStates> },
): Unit<D> {
    const { id, position, definition } = input;
    const states = initializeUnitCapabilities(
        definition,
        { tick: input.tick ?? 0 },
        input.states ?? {},
    );

    return {
        id,
        lifecycle: "PRESENT",
        definition: definition as Unit<D>["definition"],
        position,
        effects: input.effects ?? Effects.empty(),
        ...states,
    };
}
