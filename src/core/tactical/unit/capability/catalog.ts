import type { Unit, UnitDefinition } from "../unit.js";
import { copyActionState, initializeActionState } from "./action/capability.js";
import { copyAllegianceState, initializeAllegianceState } from "./allegiance.js";
import {
    copyBlockableState,
    copyBlockerState,
    initializeBlockableState,
    initializeBlockerState,
} from "./blocking.js";
import { copyEffectsState } from "./effects/capability.js";
import {
    copyDefenseState,
    initializeDefenseState,
    type DefenseDefinition,
    type DefenseState,
} from "./defense/capability.js";
import {
    copyLocomotionState,
    initializeLocomotionState,
    type RoutedLocomotionState,
} from "./locomotion/capability.js";
import { copySpatialPresenceState } from "./presence.js";
import { copyOccupancyState } from "./occupancy.js";
import {
    copyOffenseState,
    initializeOffenseState,
    type OffenseDefinition,
    type OffenseState,
} from "./offense/capability.js";
import {
    copyHitState,
    copySpatialState,
    initializeHitState,
    initializeSpatialState,
} from "./spatial.js";
import { copyStatusState, initializeStatusState } from "./status/capability.js";
import { copyVitalityState, initializeVitalityState } from "./vitality/capability.js";
import { copySkillState, initializeSkillState } from "./skill/capability.js";

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
    offense: configuredCapability<OffenseDefinition, OffenseState>(
        initializeOffenseState,
        copyOffenseState,
    ),
    defense: configuredCapability<DefenseDefinition, DefenseState>(
        initializeDefenseState,
        copyDefenseState,
    ),
    action: configuredCapability(initializeActionState, copyActionState),
    skill: configuredCapability(initializeSkillState, copySkillState),
    allegiance: configuredCapability(initializeAllegianceState, copyAllegianceState),
    spatial: configuredCapability(initializeSpatialState, copySpatialState),
    hit: configuredCapability(initializeHitState, copyHitState),
    status: configuredCapability(initializeStatusState, copyStatusState),
    blocker: configuredCapability(initializeBlockerState, copyBlockerState),
    blockable: configuredCapability(initializeBlockableState, copyBlockableState),
    locomotion: configuredCapability(initializeLocomotionState, copyLocomotionState),
});

export const runtimeCapabilities = Object.freeze({
    spatialPresence: Object.freeze({ copy: copySpatialPresenceState }),
    occupancy: Object.freeze({ copy: copyOccupancyState }),
    effects: Object.freeze({ copy: copyEffectsState }),
});

const capabilities = { ...configuredCapabilities, ...runtimeCapabilities };

export type ConfiguredCapabilityKey = keyof typeof configuredCapabilities;

type CapabilityKey = keyof typeof capabilities;

type CapabilityConfig<K extends ConfiguredCapabilityKey> = Parameters<
    (typeof configuredCapabilities)[K]["initialize"]
>[0];

type CapabilityState<K extends CapabilityKey> = Parameters<(typeof capabilities)[K]["copy"]>[0];

export type CapabilityStates = { readonly [K in CapabilityKey]: CapabilityState<K> };

export type CopiedCapabilityStates<S extends object> = {
    readonly [K in keyof S as K extends CapabilityKey ? K : never]: K extends CapabilityKey
        ? K extends "locomotion"
            ? S[K] extends RoutedLocomotionState
                ? RoutedLocomotionState
                : CapabilityState<K>
            : CapabilityState<K>
        : never;
};

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
    const initialize = configuredCapabilities[key].initialize as (
        config: CapabilityConfig<K>,
        context: CapabilityInitializationContext,
    ) => CapabilityState<K>;

    return initialize(config, context);
}

function copyCapability<K extends CapabilityKey>(
    key: K,
    state: CapabilityState<K>,
): CapabilityState<K> {
    const copy = capabilities[key].copy as (state: CapabilityState<K>) => CapabilityState<K>;

    return copy(state);
}

function copyPreparedStates(prepared: Partial<CapabilityStates>): Record<string, unknown> {
    const states: Record<string, unknown> = {};

    for (const key of capabilityKeys) {
        const state = prepared[key];

        if (state !== undefined) {
            states[key] = copyCapability(key, state);
        }
    }

    return states;
}

export function copyPreparedCapabilityStates<S extends Partial<CapabilityStates>>(
    prepared: S,
): CopiedCapabilityStates<S> {
    return copyPreparedStates(prepared) as CopiedCapabilityStates<S>;
}

export function initializeUnitCapabilities(
    definition: UnitDefinition,
    context: CapabilityInitializationContext,
    prepared: Partial<CapabilityStates>,
): object {
    const states = copyPreparedStates(prepared);

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

export function copyUnitCapabilities(unit: Unit): object {
    return copyPreparedStates(unit);
}
