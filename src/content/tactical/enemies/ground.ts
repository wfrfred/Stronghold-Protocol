import type { Profile } from "../../../data/arknights/enemy.js";
import { perSecondToPerTick, secondsToTicks } from "../../../data/arknights/tick.js";
import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../../core/common/assert.js";
import {
    createCombatDefinition,
    type CombatDefinition,
} from "../../../core/tactical/unit/archetype/enemy.js";
import type { Definition as OffenseDefinition } from "../../../core/tactical/unit/capability/offense/capability.js";
import type { DamageTargetScope } from "../../../core/tactical/unit/targeting/definition.js";

export interface AttackTiming {
    readonly windupTicks: number;
    readonly recoveryTicks: number;
    readonly hitRadius: number;
}

export interface Definition extends CombatDefinition {
    readonly offense: OffenseDefinition;
}

export function createDefinition(
    profile: Profile,
    timing: AttackTiming,
    scope: DamageTargetScope,
): Definition {
    if (profile.stunImmune) {
        throw new TypeError("this enemy content does not implement stun immunity");
    }
    if (profile.blockWeight === 0) {
        throw new TypeError("this enemy content requires a blockable ground unit");
    }

    assertNonnegativeSafeInteger(timing.windupTicks, "enemy attack windup");
    assertNonnegativeSafeInteger(timing.recoveryTicks, "enemy attack recovery");
    assertPositiveNumber(timing.hitRadius, "enemy hit radius");

    return {
        ...createCombatDefinition({
            id: profile.id,
            vitality: { maxHp: profile.maxHp },
            offense: { attack: profile.attack },
            defense: { defense: profile.defense, resistance: profile.resistance },
            allegiance: { side: "ENEMY" },
            spatial: { layer: "GROUND" },
            hit: {
                geometry: {
                    shapes: [{ type: "CIRCLE", offset: [0, 0], radius: timing.hitRadius }],
                },
            },
            status: { initialFlags: [] },
            blockable: { weight: profile.blockWeight },
            locomotion: {
                moveSpeedPerTick: perSecondToPerTick(profile.moveSpeedPerSecond),
                minimumMoveSpeedPerTick: perSecondToPerTick(0.1),
                steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
            },
            action: {
                attackSpeed: profile.attackSpeed,
                normalAction: {
                    triggerBindingId: "primary",
                    baseAttackTimeTicks: secondsToTicks(profile.baseAttackTime),
                    recoveryTicks: timing.windupTicks + timing.recoveryTicks,
                    targetGroups: [
                        {
                            id: "primary",
                            targeting: {
                                type: "DAMAGE",
                                scope,
                                canTargetAir: true,
                                includeBlockingRelations: true,
                                preferBlockingRelations: true,
                                ignoreTargetFree: false,
                                ignoreInvisible: false,
                                maxTargets: 1,
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
                },
            },
        }),
        offense: { attack: profile.attack },
    };
}
