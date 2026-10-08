import { assertNonnegativeNumber, assertPositiveNumber } from "../../../common/assert.js";
import {
    createActionCapabilityDefinition,
    type ActingUnitDefinition,
} from "../capability/action/capability.js";
import { createAllegianceState, type AllegiantUnitDefinition } from "../capability/allegiance.js";
import { createBlockableDefinition, type BlockableUnitDefinition } from "../capability/blocking.js";
import {
    createDefenseDefinition,
    type DefendedUnitDefinition,
} from "../capability/defense/capability.js";
import {
    createOffenseDefinition,
    type OffenseDefinition,
} from "../capability/offense/capability.js";
import type {
    Locomotion,
    LocomotiveUnitDefinition,
    RoutedLocomotion,
} from "../capability/locomotion/capability.js";
import type { SpatialPresence } from "../capability/presence.js";
import {
    createHitDefinition,
    createSpatialDefinition,
    type HitUnitDefinition,
    type SpatialUnitDefinition,
} from "../capability/spatial.js";
import {
    createStatusDefinition,
    type StatusUnitDefinition,
} from "../capability/status/capability.js";
import type { NormalizedUnitDefinition, Unit } from "../unit.js";
import type { Vitality, VitalUnitDefinition } from "../capability/vitality/capability.js";
import type { InitializedUnit } from "../initialize.js";
import {
    createElementalDefinition,
    type ElementalDefinition,
} from "../capability/elemental/capability.js";
import { createSkillDefinition, type SkillDefinition } from "../capability/skill/capability.js";

export interface EnemyDefinition extends VitalUnitDefinition, LocomotiveUnitDefinition {
    readonly skill?: SkillDefinition;
    readonly elemental?: ElementalDefinition;
}

export type Enemy<D extends EnemyDefinition = EnemyDefinition> = Unit<D> & Vitality & Locomotion;

export type RoutedEnemy<D extends EnemyDefinition = EnemyDefinition> = Enemy<D> &
    InitializedUnit<D> &
    RoutedLocomotion &
    SpatialPresence;

export interface CombatEnemyDefinition
    extends
        EnemyDefinition,
        ActingUnitDefinition,
        AllegiantUnitDefinition,
        SpatialUnitDefinition,
        HitUnitDefinition,
        StatusUnitDefinition,
        DefendedUnitDefinition,
        BlockableUnitDefinition {
    readonly offense?: OffenseDefinition;
}

export type CombatRoutedEnemy = RoutedEnemy<CombatEnemyDefinition>;

type NormalizedEnemyShape = EnemyDefinition & {
    readonly locomotion: EnemyDefinition["locomotion"] & {
        readonly minimumMoveSpeedPerTick: number;
    };
};

export function createEnemyDefinition<D extends EnemyDefinition>(
    definition: D,
): NormalizedUnitDefinition<D, NormalizedEnemyShape>;
export function createEnemyDefinition(definition: EnemyDefinition): NormalizedEnemyShape {
    if (definition.id.length === 0) {
        throw new TypeError("enemy definition id must be nonempty");
    }

    assertPositiveNumber(definition.vitality.maxHp, "enemy maxHp");
    assertNonnegativeNumber(definition.locomotion.moveSpeedPerTick, "enemy moveSpeedPerTick");
    const minimumMoveSpeedPerTick = definition.locomotion.minimumMoveSpeedPerTick ?? 0;
    assertNonnegativeNumber(minimumMoveSpeedPerTick, "enemy minimumMoveSpeedPerTick");

    return Object.freeze({
        id: definition.id,
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

export function createCombatEnemyDefinition<D extends CombatEnemyDefinition>(
    definition: D,
): NormalizedUnitDefinition<D, CombatEnemyDefinition & NormalizedEnemyShape>;
export function createCombatEnemyDefinition(
    definition: CombatEnemyDefinition,
): CombatEnemyDefinition & NormalizedEnemyShape {
    return Object.freeze({
        ...createEnemyDefinition(definition),
        action: createActionCapabilityDefinition(definition.action),
        allegiance: createAllegianceState(definition.allegiance),
        spatial: createSpatialDefinition(definition.spatial),
        hit: createHitDefinition(definition.hit),
        status: createStatusDefinition(definition.status),
        defense: createDefenseDefinition(definition.defense),
        ...(definition.offense === undefined
            ? {}
            : { offense: createOffenseDefinition(definition.offense) }),
        blockable: createBlockableDefinition(definition.blockable),
    });
}
