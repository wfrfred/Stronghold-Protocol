import type { Unit, UnitDefinition } from "../unit.js";
import { copyActionState, initializeActionState } from "./action.js";
import { copyAllegianceState, initializeAllegianceState } from "./allegiance.js";
import {
    copyBlockableState,
    copyBlockerState,
    initializeBlockableState,
    initializeBlockerState,
} from "./blocking.js";
import { copyLocomotionState, initializeLocomotionState } from "./locomotion/state.js";
import { copySpatialPresenceState } from "./presence.js";
import { copyOccupancyState } from "./occupancy.js";
import { copyTargetableState, initializeTargetableState } from "./targetable.js";
import { copyVitalityState, initializeVitalityState } from "./vitality.js";

export interface CapabilityInitializationContext {
    readonly tick: number;
}

function configuredCapability<C, S>(
    initialize: (config: C, context: CapabilityInitializationContext) => S,
    copy: (state: NoInfer<S>) => NoInfer<S>,
) {
    return Object.freeze({ initialize, copy });
}

export const configuredCapabilities = Object.freeze({
    vitality: configuredCapability(initializeVitalityState, copyVitalityState),
    action: configuredCapability(initializeActionState, copyActionState),
    allegiance: configuredCapability(initializeAllegianceState, copyAllegianceState),
    targetable: configuredCapability(initializeTargetableState, copyTargetableState),
    blocker: configuredCapability(initializeBlockerState, copyBlockerState),
    blockable: configuredCapability(initializeBlockableState, copyBlockableState),
    locomotion: configuredCapability(initializeLocomotionState, copyLocomotionState),
});

export const runtimeCapabilities = Object.freeze({
    spatialPresence: Object.freeze({ copy: copySpatialPresenceState }),
    occupancy: Object.freeze({ copy: copyOccupancyState }),
});

const capabilities = { ...configuredCapabilities, ...runtimeCapabilities };

export type ConfiguredCapabilityKey = keyof typeof configuredCapabilities;

type CapabilityKey = keyof typeof capabilities;

type CapabilityConfig<K extends ConfiguredCapabilityKey> = Parameters<
    (typeof configuredCapabilities)[K]["initialize"]
>[0];

type CapabilityState<K extends CapabilityKey> = Parameters<(typeof capabilities)[K]["copy"]>[0];

export type RuntimeCapabilitiesFor<D extends UnitDefinition> = {
    readonly [
        K in ConfiguredCapabilityKey as [D] extends [Readonly<Record<K, CapabilityConfig<K>>>]
            ? K
            : never
    ]: ReturnType<(typeof configuredCapabilities)[K]["initialize"]>;
};

export type PreparedCapabilityStates<D extends UnitDefinition> = Partial<
    RuntimeCapabilitiesFor<D> & {
        readonly [K in keyof typeof runtimeCapabilities]: CapabilityState<K>;
    }
>;

const configuredKeys = Object.keys(configuredCapabilities) as ConfiguredCapabilityKey[];
const capabilityKeys = Object.keys(capabilities) as CapabilityKey[];
const unitFields = new Set<PropertyKey>(["id", "definition", "position", ...capabilityKeys]);

function stateRecord(value: unknown, key: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`capability ${key} state must be an object`);
    }

    return value as Record<string, unknown>;
}

export function assertUnitCapabilityConsistency(unit: Unit): void {
    for (const key of configuredKeys) {
        const configured = key in unit.definition;
        const present = key in unit;

        if (configured !== present) {
            throw new TypeError(`capability ${key} configuration and state must be paired`);
        }
        if (present) {
            stateRecord(Reflect.get(unit, key) as unknown, key);
        }
    }
}

function initializeCapability<K extends ConfiguredCapabilityKey>(
    key: K,
    config: CapabilityConfig<K>,
    context: CapabilityInitializationContext,
): CapabilityState<K> {
    const initialize = configuredCapabilities[key].initialize as (
        config: CapabilityConfig<K>,
        context: CapabilityInitializationContext,
    ) => CapabilityState<K>;

    return initialize(config, context);
}

function copyCapability<K extends CapabilityKey>(key: K, state: unknown): CapabilityState<K> {
    const copy = capabilities[key].copy as (state: CapabilityState<K>) => CapabilityState<K>;

    return copy(stateRecord(state, key) as CapabilityState<K>);
}

export function initializeUnitCapabilities(
    definition: UnitDefinition,
    context: CapabilityInitializationContext,
    prepared: object,
): object {
    const states: Record<string, unknown> = {};

    for (const key of Reflect.ownKeys(prepared)) {
        if (typeof key !== "string" || !Object.hasOwn(capabilities, key)) {
            throw new TypeError(`unregistered prepared capability ${String(key)}`);
        }
        if (Object.hasOwn(configuredCapabilities, key) && !(key in definition)) {
            throw new TypeError(`prepared capability ${key} requires configuration`);
        }

        states[key] = copyCapability(key as CapabilityKey, Reflect.get(prepared, key) as unknown);
    }

    for (const key of configuredKeys) {
        if (!(key in definition) || key in states) {
            continue;
        }

        const config = Reflect.get(definition, key) as CapabilityConfig<typeof key>;

        states[key] = initializeCapability(key, config, context);
    }

    return states;
}

export function copyUnitCapabilities(unit: Unit): object {
    assertUnitCapabilityConsistency(unit);

    for (const key of Reflect.ownKeys(unit)) {
        if (!unitFields.has(key)) {
            throw new TypeError(`unregistered unit field ${String(key)} requires a custom copier`);
        }
    }

    const states: Record<string, unknown> = {};

    for (const key of capabilityKeys) {
        if (key in unit) {
            states[key] = copyCapability(key, Reflect.get(unit, key) as unknown);
        }
    }

    return states;
}
