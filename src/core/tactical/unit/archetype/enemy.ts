import { assertNonnegativeNumber, assertPositiveNumber } from "../../../common/assert.js";
import {
    createDefinition as createActionCapabilityDefinition,
    type Definition as ActionCapabilityDefinition,
} from "../capability/action/capability.js";
import type { Definition as AllegianceDefinition } from "../capability/allegiance.js";
import {
    createDefinition as createBlockableDefinition,
    type Definition as BlockableDefinition,
} from "../capability/blocking/blockable.js";
import {
    createDefinition as createDefenseDefinition,
    type Definition as DefenseDefinition,
} from "../capability/defense/capability.js";
import {
    createDefinition as createOffenseDefinition,
    type Definition as OffenseDefinition,
} from "../capability/offense/capability.js";
import type {
    Locomotion,
    Definition as LocomotionDefinition,
    RoutedLocomotion,
} from "../capability/locomotion/capability.js";
import type { SpatialPresence } from "../capability/presence.js";
import {
    createHitDefinition,
    type HitDefinition,
    type SpatialDefinition,
} from "../capability/spatial.js";
import type { Definition as StatusDefinition } from "../capability/status/capability.js";
import type { Unit, Definition as UnitDefinition } from "../unit.js";
import type {
    Vitality,
    Definition as VitalityDefinition,
} from "../capability/vitality/capability.js";
import type * as initialization from "../initialize.js";
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
    readonly skill?: SkillDefinition;
    readonly elemental?: ElementalDefinition;
}

export type Enemy = Unit & Vitality & Locomotion;

export type RoutedEnemy<D extends Definition = Definition> = Enemy &
    initialization.Result<D> &
    RoutedLocomotion &
    SpatialPresence;

export interface CombatDefinition extends Definition {
    readonly action: ActionCapabilityDefinition;
    readonly allegiance: AllegianceDefinition;
    readonly spatial: SpatialDefinition;
    readonly hit: HitDefinition;
    readonly status: StatusDefinition;
    readonly defense: DefenseDefinition;
    readonly blockable: BlockableDefinition;
    readonly offense?: OffenseDefinition;
}

export type CombatRoutedEnemy = RoutedEnemy<CombatDefinition>;

export function createDefinition(definition: Definition): Definition {
    if (definition.id.length === 0) {
        throw new TypeError("enemy definition id must be nonempty");
    }

    assertPositiveNumber(definition.vitality.maxHp, "enemy maxHp");
    assertNonnegativeNumber(definition.locomotion.moveSpeedPerTick, "enemy moveSpeedPerTick");
    const minimumMoveSpeedPerTick = definition.locomotion.minimumMoveSpeedPerTick ?? 0;
    assertNonnegativeNumber(minimumMoveSpeedPerTick, "enemy minimumMoveSpeedPerTick");

    return Object.freeze({
        id: definition.id,
        ...(definition.onEnter === undefined ? {} : { onEnter: definition.onEnter }),
        ...(definition.onLeave === undefined ? {} : { onLeave: definition.onLeave }),
        vitality: Object.freeze({ maxHp: definition.vitality.maxHp }),
        locomotion: Object.freeze({
            moveSpeedPerTick: definition.locomotion.moveSpeedPerTick,
            minimumMoveSpeedPerTick,
            steeringParameters: Object.freeze({ ...definition.locomotion.steeringParameters }),
        }),
        ...(definition.elemental === undefined
            ? {}
            : { elemental: createElementalDefinition(definition.elemental) }),
        ...(definition.skill === undefined
            ? {}
            : { skill: createSkillDefinition(definition.skill) }),
    });
}

export function createCombatDefinition(definition: CombatDefinition): CombatDefinition {
    return Object.freeze({
        ...createDefinition(definition),
        action: createActionCapabilityDefinition(definition.action),
        allegiance: definition.allegiance,
        spatial: definition.spatial,
        hit: createHitDefinition(definition.hit),
        status: definition.status,
        defense: createDefenseDefinition(definition.defense),
        ...(definition.offense === undefined
            ? {}
            : { offense: createOffenseDefinition(definition.offense) }),
        blockable: createBlockableDefinition(definition.blockable),
    });
}
