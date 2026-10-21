import type { Definition as ElementalDefinition } from "../../../core/tactical/unit/capability/elemental/capability.js";
import type { Definition as TargetableDefinition } from "../../../core/tactical/unit/capability/targetable/capability.js";
import { createArknightsElementalDefinition } from "../../../data/arknights/elemental.js";
import { getUnit, updateUnit } from "../../../core/tactical/battle/state.js";
import { ref as unitRef } from "../../../core/tactical/unit/query.js";
import { isCasting } from "../../../core/tactical/unit/action/operations.js";
import { hasLocomotion } from "../../../core/tactical/unit/capability/locomotion/capability.js";
import { setRule } from "../../../core/tactical/unit/capability/locomotion/operations.js";
import { Definitions } from "../../../core/tactical/unit/action/definitions.js";
import { create as createAttack, type Attack } from "../actions/attack.js";
import type { Profile } from "../../../data/arknights/enemy.js";
import { perSecondToPerTick, secondsToTicks } from "../../../data/arknights/tick.js";
import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../../core/common/assert.js";
import {
    createCombatDefinition,
    type CombatDefinition,
} from "../../../core/tactical/unit/archetype/enemy.js";
import type { Definition as OffenseDefinition } from "../../../core/tactical/unit/capability/offense/capability.js";
import type { RangeGeometry } from "../../../core/tactical/geometry/shape.js";
import * as filters from "../../../core/tactical/battle/targeting/filter.js";
import * as compare from "../../../core/tactical/battle/targeting/compare.js";
import { first } from "../../../core/tactical/battle/targeting/selector.js";

export type Scope =
    { readonly type: "RANGE"; readonly geometry: RangeGeometry } | { readonly type: "BLOCKER" };

export interface AttackTiming {
    readonly windupTicks: number;
    readonly recoveryTicks: number;
    readonly hitRadius: number;
}

export interface Definition extends CombatDefinition {
    readonly elemental: ElementalDefinition;
    readonly targetable: TargetableDefinition;
    readonly offense: OffenseDefinition;
    readonly attack: Attack;
}

export function createDefinition(
    profile: Profile,
    timing: AttackTiming,
    scope: Scope,
    halfBodyWidth: number,
): Definition {
    if (profile.stunImmune) {
        throw new TypeError("this enemy content does not implement stun immunity");
    }
    if (profile.blockVolume === 0) {
        throw new TypeError("this enemy content requires a blockable ground unit");
    }

    assertNonnegativeSafeInteger(timing.windupTicks, "enemy attack windup");
    assertNonnegativeSafeInteger(timing.recoveryTicks, "enemy attack recovery");
    assertPositiveNumber(timing.hitRadius, "enemy hit radius");

    const attack = createAttack({
        id: "normal-attack",
        speed: profile.attackSpeed,
        triggerBindingId: "primary",
        intervalTicks: secondsToTicks(profile.baseAttackTime),
        windupTicks: timing.windupTicks,
        recoveryTicks: timing.recoveryTicks,
        targetGroups: [
            {
                id: "primary",
                targeting: {
                    purposes: ["DAMAGE"],
                    filter: filters.and(
                        filters.damage,
                        scope.type === "BLOCKER"
                            ? filters.blocker
                            : filters.or(filters.range(scope.geometry), filters.blocking),
                    ),
                    selector: first(1, compare.combine(compare.blockedFirst, compare.distance)),
                },
                operations: [
                    {
                        type: "DAMAGE",
                        power: profile.attack,
                        powerSource: "SOURCE_ATTACK",
                        damageType: "PHYSICAL",
                    },
                ],
            },
        ],
        followUps: [],
    });

    const elemental = createArknightsElementalDefinition({ receiver: "ENEMY" });

    return {
        ...createCombatDefinition({
            id: profile.id,
            onEnter(battle, unitId) {
                const unit = getUnit(battle, unitId);

                return unit === undefined || !hasLocomotion(unit)
                    ? battle
                    : updateUnit(battle, {
                          ...unit,
                          locomotion: setRule(unit.locomotion, {
                              id: "attack-casting",
                              allows: (current, self) => !isCasting(current, unitRef(self)),
                          }),
                      });
            },
            elemental,
            vitality: {
                maxHp: profile.maxHp,
                defense: profile.defense,
                resistance: profile.resistance,
            },
            offense: { attack: profile.attack },

            allegiance: { side: "ENEMY" },
            spatial: { layer: "GROUND" },
            hit: {
                geometry: {
                    shapes: [{ type: "CIRCLE", offset: [0, 0], radius: timing.hitRadius }],
                },
            },
            blockable: { volume: profile.blockVolume },
            locomotion: {
                speed: perSecondToPerTick(profile.moveSpeedPerSecond),
                minSpeed: perSecondToPerTick(0.1),
                steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
                halfBodyWidth,
            },
            action: { definitions: Definitions.empty().add(attack) },
        }),
        elemental,
        targetable: { restrictions: [] },
        offense: { attack: profile.attack },
        attack,
    };
}
