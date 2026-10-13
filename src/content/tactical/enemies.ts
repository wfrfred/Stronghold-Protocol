import type { Profile } from "../../data/arknights/enemy.js";
import { perSecondToPerTick, secondsToTicks } from "../../data/arknights/tick.js";
import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../core/common/assert.js";
import {
    createCombatDefinition,
    type CombatDefinition,
} from "../../core/tactical/unit/archetype/enemy.js";
import type { Definition as OffenseDefinition } from "../../core/tactical/unit/capability/offense/capability.js";
import { compileAction } from "../../core/tactical/unit/capability/action/compile.js";
import type { CompiledAction } from "../../core/tactical/unit/capability/action/compiled.js";
import type { ActionResources } from "../../core/tactical/unit/capability/action/resources.js";
import type { CompiledActionSegment } from "../../core/tactical/unit/capability/action/process.js";
import { hasAllegiance } from "../../core/tactical/unit/capability/allegiance.js";
import { hasVitality } from "../../core/tactical/unit/capability/vitality/capability.js";
import { resolveAttackPower } from "../../core/tactical/unit/capability/offense/query.js";
import { createDamageOperands } from "../../core/tactical/unit/capability/vitality/damage/contract.js";
import { battlefieldView, getUnit } from "../../core/tactical/battle/state.js";
import type { CombatResources } from "../../core/tactical/battle/resources.js";
import {
    createProjectileDefinition,
    type ProjectileDefinitionRef,
} from "../../core/tactical/battlefield/projectile/definition.js";
import { resolveProjectileAttackPower } from "../../core/tactical/battlefield/projectile/operations.js";
import type { Result as InitializedUnit } from "../../core/tactical/unit/initialize.js";

export interface Projectile {
    readonly ref: ProjectileDefinitionRef<object>;
    readonly speedPerSecond: number;
    readonly contactRadius: number;
    readonly stopDelayTicks: number;
}

export interface AttackTiming {
    readonly windupTicks: number;
    readonly recoveryTicks: number;
    readonly hitRadius: number;
    readonly projectile?: Projectile;
}

export interface Definition extends CombatDefinition {
    readonly offense: OffenseDefinition;
    readonly profile: Profile;
    readonly attackTiming: AttackTiming;
}

export type Enemy = InitializedUnit<Definition>;

/** Numeric table values and explicitly selected animation timings form the content definition. */
export function createDefinition(profile: Profile, timing: AttackTiming): Definition {
    if (profile.id !== "enemy_1000_gopro" && profile.id !== "enemy_1003_ncbow") {
        throw new TypeError(`enemy content is not implemented: ${profile.id}`);
    }
    if (profile.stunImmune) {
        throw new TypeError("this enemy content does not implement stun immunity");
    }
    if (profile.blockWeight === 0) {
        throw new TypeError("this enemy content requires a blockable ground unit");
    }
    if (profile.applyWay === "MELEE" && timing.projectile !== undefined) {
        throw new TypeError("melee enemy attacks do not launch arrows");
    }
    if (profile.applyWay === "RANGED" && timing.projectile === undefined) {
        throw new TypeError("ranged enemy content requires projectile configuration");
    }

    assertNonnegativeSafeInteger(timing.windupTicks, "enemy attack windup");
    assertNonnegativeSafeInteger(timing.recoveryTicks, "enemy attack recovery");
    assertPositiveNumber(timing.hitRadius, "enemy hit radius");

    if (timing.projectile !== undefined) {
        assertPositiveNumber(timing.projectile.speedPerSecond, "enemy arrow speed");
        assertPositiveNumber(timing.projectile.contactRadius, "enemy arrow contact radius");
        assertNonnegativeSafeInteger(timing.projectile.stopDelayTicks, "enemy arrow stop delay");
    }

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
                                scope:
                                    profile.applyWay === "MELEE"
                                        ? { type: "BLOCKER" }
                                        : {
                                              type: "RANGE",
                                              geometry: {
                                                  type: "SHAPES",
                                                  geometry: {
                                                      shapes: [
                                                          {
                                                              type: "CIRCLE",
                                                              offset: [0, 0],
                                                              radius: profile.rangeRadius,
                                                          },
                                                      ],
                                                  },
                                              },
                                          },
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
        profile,
        attackTiming: timing,
    };
}

export function registerArrow(resources: CombatResources): ProjectileDefinitionRef<object> {
    return resources.projectiles.register(
        createProjectileDefinition({
            id: "main-mode-crossbow-arrow",
            initialize: () => ({}),
            acceptsContact: (context, target) =>
                target.id === context.projectile.traceTarget &&
                hasAllegiance(target) &&
                target.allegiance.side === "ALLY" &&
                hasVitality(target) &&
                target.vitality.hp > 0,
            contact: (state, context) =>
                resources.settleDamage(
                    state,
                    {
                        sourceUnitId: context.projectile.source,
                        targetUnitId: context.targetUnitId,
                        tick: context.tick,
                        damageType: "PHYSICAL",
                        operands: createDamageOperands(
                            resolveProjectileAttackPower(state, context.projectile),
                        ),
                    },
                    context.call,
                ).state,
        }),
    ).ref;
}

export function compileNormalAction(
    definition: Definition,
    resources: ActionResources,
): CompiledAction {
    const action = compileAction(definition.action.normalAction, resources);
    const { windupTicks, recoveryTicks, projectile } = definition.attackTiming;
    const program: CompiledActionSegment[] = [];

    if (windupTicks > 0) {
        program.push({
            type: "WAIT",
            blockingMovement: true,
            allowNewAction: false,
            resolve: () => ({ type: "FOR_TICKS", ticks: windupTicks }),
        });
    }

    program.push({ type: "RELEASE", markerId: "normal-attack" });

    if (projectile === undefined) {
        program.push(...action.program);
    } else {
        program.push({
            type: "EXECUTE",
            run: (state, context) => {
                const source = getUnit(state, context.sourceUnitId);
                const targetId = context.bindings.get(action.definition.triggerBindingId)?.[0];
                const target = targetId === undefined ? undefined : getUnit(state, targetId);

                if (source === undefined || target === undefined) {
                    return { state, value: { continuation: "FINISH" } };
                }

                const cachedAtk = resolveAttackPower(source.id, battlefieldView(state));

                if (cachedAtk === undefined || context.projectiles === undefined) {
                    throw new Error(
                        "enemy arrow action requires Offense and projectile operations",
                    );
                }

                const launched = context.projectiles.launch(state, projectile.ref, {
                    source: source.id,
                    traceTarget: target.id,
                    position: source.position,
                    destination: target.position,
                    cachedAtk,
                    speedPerTick: perSecondToPerTick(projectile.speedPerSecond),
                    contactRange: {
                        type: "SHAPES",
                        geometry: {
                            shapes: [
                                {
                                    type: "CIRCLE",
                                    offset: [0, 0],
                                    radius: projectile.contactRadius,
                                },
                            ],
                        },
                    },
                    stopDelayTicks: projectile.stopDelayTicks,
                });

                return { state: launched.state, value: undefined };
            },
        });
    }

    if (recoveryTicks > 0) {
        program.push({
            type: "WAIT",
            blockingMovement: true,
            allowNewAction: false,
            resolve: () => ({ type: "FOR_TICKS", ticks: recoveryTicks }),
        });
    }

    return { ...action, program };
}
