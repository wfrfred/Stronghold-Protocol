import type { Unit, UnitDefinition } from "../unit.js";
import { initializeActionState } from "./action/capability.js";
import { initializeAllegianceState } from "./allegiance.js";
import { initializeBlockableState, initializeBlockerState } from "./blocking/capability.js";
import type { EffectsState } from "./effects/capability.js";
import { initializeDefenseState } from "./defense/capability.js";
import { initializeLocomotionState, type RoutedLocomotionState } from "./locomotion/capability.js";
import type { SpatialPresenceState } from "./presence.js";
import type { OccupancyState } from "./occupancy.js";
import { initializeOffenseState } from "./offense/capability.js";
import { initializeHitState, initializeSpatialState } from "./spatial.js";
import { initializeStatusState } from "./status/capability.js";
import { initializeVitalityState } from "./vitality/capability.js";
import { initializeElementalState } from "./elemental/capability.js";
import { initializeSkillState } from "./skill/capability.js";

export interface CapabilityInitializationContext {
    readonly tick: number;
}

export const configuredCapabilities = {
    vitality: initializeVitalityState,
    offense: initializeOffenseState,
    defense: initializeDefenseState,
    action: initializeActionState,
    skill: initializeSkillState,
    elemental: initializeElementalState,
    allegiance: initializeAllegianceState,
    spatial: initializeSpatialState,
    hit: initializeHitState,
    status: initializeStatusState,
    blocker: initializeBlockerState,
    blockable: initializeBlockableState,
    locomotion: initializeLocomotionState,
} as const;

interface RuntimeCapabilityStates {
    readonly spatialPresence: SpatialPresenceState;
    readonly occupancy: OccupancyState;
    readonly effects: EffectsState;
}

export type ConfiguredCapabilityKey = keyof typeof configuredCapabilities;

type CapabilityConfig<K extends ConfiguredCapabilityKey> = Parameters<
    (typeof configuredCapabilities)[K]
>[0];

export type CapabilityStates = {
    readonly [K in ConfiguredCapabilityKey]: ReturnType<(typeof configuredCapabilities)[K]>;
} & RuntimeCapabilityStates;

type CapabilityKey = keyof CapabilityStates;

type CapabilityState<K extends CapabilityKey> = CapabilityStates[K];

export type WidenedCapabilityState<K extends CapabilityKey, S> = K extends "locomotion"
    ? NonNullable<S> extends RoutedLocomotionState
        ? RoutedLocomotionState
        : CapabilityState<K>
    : CapabilityState<K>;

export type SelectedCapabilityStates<S extends object> = {
    readonly [K in keyof S as K extends CapabilityKey ? K : never]: K extends CapabilityKey
        ? WidenedCapabilityState<K, S[K]>
        : never;
};

export type RuntimeCapabilitiesFor<D extends UnitDefinition> = {
    readonly [
        K in ConfiguredCapabilityKey as [D] extends [Readonly<Record<K, CapabilityConfig<K>>>]
            ? K
            : never
    ]: CapabilityState<K>;
};

export type PreparedCapabilityStates<D extends UnitDefinition> = Partial<
    RuntimeCapabilitiesFor<D> & RuntimeCapabilityStates
>;

const configuredKeys = Object.keys(configuredCapabilities) as ConfiguredCapabilityKey[];
const capabilityKeys: readonly CapabilityKey[] = [
    ...configuredKeys,
    "spatialPresence",
    "occupancy",
    "effects",
];

function hasCapabilityState(unit: Unit, key: ConfiguredCapabilityKey): boolean {
    return key in unit && Reflect.get(unit, key) !== undefined;
}

export function assertUnitCapabilityPairing(unit: Unit): void {
    for (const key of configuredKeys) {
        const configured = key in unit.definition;

        if (configured !== hasCapabilityState(unit, key)) {
            throw new TypeError(`capability ${key} configuration and state must be paired`);
        }
    }
}

export function assertUnitCapabilityComposition(previous: Unit, unit: Unit): void {
    for (const key of configuredKeys) {
        if (hasCapabilityState(previous, key) !== hasCapabilityState(unit, key)) {
            throw new TypeError(`capability ${key} state cannot be added or removed during update`);
        }
    }
}

function initializeCapability<K extends ConfiguredCapabilityKey>(
    key: K,
    config: CapabilityConfig<K>,
    context: CapabilityInitializationContext,
): CapabilityState<K> {
    const initialize = configuredCapabilities[key] as (
        config: CapabilityConfig<K>,
        context: CapabilityInitializationContext,
    ) => CapabilityState<K>;

    return initialize(config, context);
}

export function selectCapabilityStates<S extends Partial<CapabilityStates>>(
    source: S,
): SelectedCapabilityStates<S> {
    const states: Record<string, unknown> = {};

    for (const key of capabilityKeys) {
        const state = source[key];

        if (state !== undefined) {
            states[key] = state;
        }
    }

    return states as SelectedCapabilityStates<S>;
}

export function initializeUnitCapabilities(
    definition: UnitDefinition,
    context: CapabilityInitializationContext,
    prepared: Partial<CapabilityStates>,
): object {
    const states: Record<string, unknown> = selectCapabilityStates(prepared);

    for (const key of configuredKeys) {
        if (!(key in definition)) {
            if (key in states) {
                throw new TypeError(`prepared capability ${key} requires configuration`);
            }

            continue;
        }
        if (key in states) {
            continue;
        }

        const config = Reflect.get(definition, key) as CapabilityConfig<typeof key>;

        states[key] = initializeCapability(key, config, context);
    }

    return states;
}
