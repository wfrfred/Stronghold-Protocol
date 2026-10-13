import type { Unit, Definition } from "../unit.js";
import {
    initializeActionState,
    type ActionCapabilityDefinition,
    type ActionState,
} from "./action/capability.js";
import { initializeAllegianceState, type AllegianceState } from "./allegiance.js";
import {
    initializeBlockableState,
    initializeBlockerState,
    type BlockableDefinition,
    type BlockableState,
    type BlockerDefinition,
    type BlockerState,
} from "./blocking/capability.js";
import {
    initializeDefenseState,
    type DefenseDefinition,
    type DefenseState,
} from "./defense/capability.js";
import {
    initializeLocomotionState,
    type LocomotionDefinition,
    type LocomotionState,
    type RoutedLocomotionState,
} from "./locomotion/capability.js";
import type { SpatialPresenceState } from "./presence.js";
import type { OccupancyState } from "./occupancy.js";
import {
    initializeOffenseState,
    type OffenseDefinition,
    type OffenseState,
} from "./offense/capability.js";
import {
    initializeHitState,
    initializeSpatialState,
    type HitDefinition,
    type HitState,
    type SpatialDefinition,
    type SpatialState,
} from "./spatial.js";
import {
    initializeStatusState,
    type StatusDefinition,
    type StatusState,
} from "./status/capability.js";
import {
    initializeVitalityState,
    type VitalityDefinition,
    type VitalityState,
} from "./vitality/capability.js";
import {
    initializeElementalState,
    type ElementalDefinition,
    type ElementalState,
} from "./elemental/capability.js";
import { initializeSkillState, type SkillDefinition, type SkillState } from "./skill/capability.js";

export interface CapabilityInitializationContext {
    readonly tick: number;
}

interface CapabilityConfigurations {
    readonly vitality: VitalityDefinition;
    readonly offense: OffenseDefinition;
    readonly defense: DefenseDefinition;
    readonly action: ActionCapabilityDefinition;
    readonly skill: SkillDefinition;
    readonly elemental: ElementalDefinition;
    readonly allegiance: AllegianceState;
    readonly spatial: SpatialDefinition;
    readonly hit: HitDefinition;
    readonly status: StatusDefinition;
    readonly blocker: BlockerDefinition;
    readonly blockable: BlockableDefinition;
    readonly locomotion: LocomotionDefinition;
}

interface RuntimeCapabilityStates {
    readonly spatialPresence: SpatialPresenceState;
    readonly occupancy: OccupancyState;
}

export type ConfiguredCapabilityKey = keyof CapabilityConfigurations;

type CapabilityConfig<K extends ConfiguredCapabilityKey> = CapabilityConfigurations[K];

export type CapabilityStates = {
    readonly vitality: VitalityState;
    readonly offense: OffenseState;
    readonly defense: DefenseState;
    readonly action: ActionState;
    readonly skill: SkillState;
    readonly elemental: ElementalState;
    readonly allegiance: AllegianceState;
    readonly spatial: SpatialState;
    readonly hit: HitState;
    readonly status: StatusState;
    readonly blocker: BlockerState;
    readonly blockable: BlockableState;
    readonly locomotion: LocomotionState;
} & RuntimeCapabilityStates;

export const configuredCapabilities: {
    readonly [K in ConfiguredCapabilityKey]: (
        config: CapabilityConfig<K>,
        context: CapabilityInitializationContext,
    ) => CapabilityStates[K];
} = {
    vitality: initializeVitalityState,
    offense: () => initializeOffenseState(),
    defense: () => initializeDefenseState(),
    action: (_definition, context) => initializeActionState(context.tick),
    skill: initializeSkillState,
    elemental: initializeElementalState,
    allegiance: initializeAllegianceState,
    spatial: initializeSpatialState,
    hit: initializeHitState,
    status: initializeStatusState,
    blocker: initializeBlockerState,
    blockable: initializeBlockableState,
    locomotion: () => initializeLocomotionState(),
};

type CapabilityKey = keyof CapabilityStates;

type CapabilityState<K extends CapabilityKey> = CapabilityStates[K];

type SelectedCapabilityState<K extends CapabilityKey, S> = K extends "locomotion"
    ? NonNullable<S> extends RoutedLocomotionState
        ? RoutedLocomotionState
        : CapabilityState<K>
    : CapabilityState<K>;

export type SelectedCapabilityStates<S extends object> = {
    readonly [K in keyof S as K extends CapabilityKey ? K : never]: K extends CapabilityKey
        ? SelectedCapabilityState<K, S[K]>
        : never;
};

export type RuntimeCapabilitiesFor<D extends Definition> = {
    readonly [
        K in ConfiguredCapabilityKey as [D] extends [Readonly<Record<K, CapabilityConfig<K>>>]
            ? K
            : never
    ]: CapabilityState<K>;
};

export type PreparedCapabilityStates<D extends Definition> = Partial<
    RuntimeCapabilitiesFor<D> & RuntimeCapabilityStates
>;

const configuredKeys = Object.keys(configuredCapabilities) as ConfiguredCapabilityKey[];
const capabilityKeys: readonly CapabilityKey[] = [
    ...configuredKeys,
    "spatialPresence",
    "occupancy",
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
    return configuredCapabilities[key](config, context);
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
    definition: Definition,
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
