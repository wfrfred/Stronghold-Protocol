import { assertNonnegativeNumber } from "../../../common/assert.js";
import {
    createDefinition as createActionCapabilityDefinition,
    type Definition as ActionCapabilityDefinition,
} from "../capability/action/capability.js";
import type { Definition as AllegianceDefinition } from "../capability/allegiance/capability.js";
import type { Definition as BlockableDefinition } from "../capability/blocking/blockable.js";
import type { Definition as OffenseDefinition } from "../capability/offense/capability.js";
import type {
    Locomotion,
    Definition as LocomotionDefinition,
} from "../capability/locomotion/capability.js";
import type { Route } from "../capability/route/capability.js";
import type {
    SpatialPresence,
    Definition as PresenceDefinition,
} from "../capability/presence/capability.js";
import type { Definition as HitboxDefinition } from "../capability/hitbox/capability.js";
import type { Definition as LayerDefinition } from "../capability/layer/capability.js";
import type { Unit, Definition as UnitDefinition } from "../unit.js";
import type {
    Vitality,
    Definition as VitalityDefinition,
} from "../capability/vitality/capability.js";
import type { Product } from "../capability/catalog.js";
import type { Definition as TargetableDefinition } from "../capability/targetable/capability.js";
import type { Definition as OccupancyDefinition } from "../capability/occupancy/capability.js";
import {
    createDefinition as createElementalDefinition,
    type Definition as ElementalDefinition,
} from "../capability/elemental/capability.js";
import {
    createDefinition as createSkillDefinition,
    type Definition as SkillDefinition,
} from "../capability/skill/capability.js";

export interface Definition extends UnitDefinition {
    readonly vitality: VitalityDefinition;
    readonly locomotion: LocomotionDefinition;
    readonly spatialPresence: PresenceDefinition;
    readonly skill?: SkillDefinition;
    readonly elemental?: ElementalDefinition;
    readonly targetable?: TargetableDefinition;
    readonly occupancy?: OccupancyDefinition;
}

export type Enemy = Unit & Vitality & Locomotion;

export type RoutedEnemy<D extends Definition = Definition> = Enemy &
    Product<D> &
    Route &
    SpatialPresence;

export interface CombatDefinition extends Definition {
    readonly action: ActionCapabilityDefinition;
    readonly allegiance: AllegianceDefinition;
    readonly layer: LayerDefinition;
    readonly hitbox: HitboxDefinition;
    readonly blockable: BlockableDefinition;
    readonly offense?: OffenseDefinition;
}

export type CombatRoutedEnemy = RoutedEnemy<CombatDefinition>;

export function createDefinition(
    definition: Omit<Definition, "spatialPresence"> & Partial<Pick<Definition, "spatialPresence">>,
): Definition {
    if (definition.id.length === 0) {
        throw new TypeError("enemy definition id must be nonempty");
    }

    assertNonnegativeNumber(definition.locomotion.speed, "enemy speed");
    assertNonnegativeNumber(definition.locomotion.minSpeed, "enemy minSpeed");
    assertNonnegativeNumber(definition.locomotion.halfBodyWidth, "enemy halfBodyWidth");

    return Object.freeze({
        id: definition.id,
        ...(definition.onEnter === undefined ? {} : { onEnter: definition.onEnter }),
        ...(definition.onTick === undefined ? {} : { onTick: definition.onTick }),
        ...(definition.onLeave === undefined ? {} : { onLeave: definition.onLeave }),
        vitality: Object.freeze({ ...definition.vitality }),
        spatialPresence: Object.freeze(definition.spatialPresence ?? {}),
        ...(definition.targetable === undefined ? {} : { targetable: definition.targetable }),
        ...(definition.occupancy === undefined ? {} : { occupancy: definition.occupancy }),
        locomotion: Object.freeze({
            speed: definition.locomotion.speed,
            minSpeed: definition.locomotion.minSpeed,
            steeringParameters: Object.freeze({ ...definition.locomotion.steeringParameters }),
            halfBodyWidth: definition.locomotion.halfBodyWidth,
        }),
        ...(definition.elemental === undefined
            ? {}
            : { elemental: createElementalDefinition(definition.elemental) }),
        ...(definition.skill === undefined
            ? {}
            : { skill: createSkillDefinition(definition.skill) }),
    });
}

export function createCombatDefinition(
    definition: Omit<CombatDefinition, "spatialPresence"> &
        Partial<Pick<CombatDefinition, "spatialPresence">>,
): CombatDefinition {
    return Object.freeze({
        ...createDefinition(definition),
        action: createActionCapabilityDefinition(definition.action),
        allegiance: definition.allegiance,
        layer: definition.layer,
        hitbox: definition.hitbox,
        ...(definition.offense === undefined ? {} : { offense: definition.offense }),
        blockable: definition.blockable,
    });
}
