import type { Unit, Definition as UnitDefinition } from "../unit.js";
import {
    initialize as initializeActionState,
    type Definition as ActionCapabilityDefinition,
    type State as ActionState,
} from "./action/capability.js";
import {
    initialize as initializeAllegianceState,
    type Definition as AllegianceDefinition,
    type State as AllegianceState,
} from "./allegiance.js";
import {
    initialize as initializeBlockableState,
    type Definition as BlockableDefinition,
    type State as BlockableState,
} from "./blocking/blockable.js";
import {
    initialize as initializeBlockerState,
    type Definition as BlockerDefinition,
    type State as BlockerState,
} from "./blocking/blocker.js";
import {
    initialize as initializeDefenseState,
    type Definition as DefenseDefinition,
    type State as DefenseState,
} from "./defense/capability.js";
import {
    initialize as initializeLocomotionState,
    type Definition as LocomotionDefinition,
    type State as LocomotionState,
    type RoutedLocomotionState,
} from "./locomotion/capability.js";
import type { State as SpatialPresenceState } from "./presence.js";
import type { State as OccupancyState } from "./occupancy.js";
import {
    initialize as initializeOffenseState,
    type Definition as OffenseDefinition,
    type State as OffenseState,
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
    initialize as initializeStatusState,
    type Definition as StatusDefinition,
    type State as StatusState,
} from "./status/capability.js";
import {
    initialize as initializeVitalityState,
    type Definition as VitalityDefinition,
    type State as VitalityState,
} from "./vitality/capability.js";
import {
    initialize as initializeElementalState,
    type Definition as ElementalDefinition,
    type State as ElementalState,
} from "./elemental/capability.js";
import {
    initialize as initializeSkillState,
    type Definition as SkillDefinition,
    type State as SkillState,
} from "./skill/capability.js";

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
    readonly allegiance: AllegianceDefinition;
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
