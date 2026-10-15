import { resolveDamage } from "../../../core/tactical/unit/capability/vitality/damage/settlement.js";
import type { Profile } from "../../../data/arknights/enemy.js";
import { perSecondToPerTick } from "../../../data/arknights/tick.js";
import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../../core/common/assert.js";
import type { CombatResources } from "../../../core/tactical/battle/resources.js";
import { battlefieldView, getUnit } from "../../../core/tactical/battle/state.js";
import {
    createDefinition as createProjectileDefinition,
    type Definition as ProjectileDefinition,
} from "../../../core/tactical/battlefield/projectile/definition.js";
import {
    launchProjectile,
    resolveProjectileAttackPower,
} from "../../../core/tactical/battlefield/projectile/operations.js";
import { hasAllegiance } from "../../../core/tactical/unit/capability/allegiance/capability.js";
import { compileAction } from "../../../core/tactical/unit/capability/action/compile.js";
import type { CompiledAction } from "../../../core/tactical/unit/capability/action/compiled.js";
import type { CompiledActionSegment } from "../../../core/tactical/unit/capability/action/process.js";
import { resolveAttackPower } from "../../../core/tactical/unit/capability/offense/query.js";
import { hasVitality } from "../../../core/tactical/unit/capability/vitality/capability.js";
import { createDamageOperands } from "../../../core/tactical/unit/capability/vitality/damage/contract.js";
import type { Result as InitializedUnit } from "../../../core/tactical/unit/initialize.js";
import { withTiming } from "./attack.js";
import {
    createDefinition as createGroundDefinition,
    type AttackTiming as GroundAttackTiming,
    type Definition as GroundDefinition,
} from "./ground.js";

export interface Projectile {
    readonly definition: ProjectileDefinition<object>;
    readonly speedPerSecond: number;
    readonly contactRadius: number;
    readonly stopDelayTicks: number;
}

export interface AttackTiming extends GroundAttackTiming {
    readonly projectile: Projectile;
}

export interface Definition extends GroundDefinition {
    readonly profile: Profile;
    readonly attackTiming: AttackTiming;
}

export type Enemy = InitializedUnit<Definition>;

export function createArrow(resources: CombatResources): ProjectileDefinition<object> {
    return createProjectileDefinition({
        id: "main-mode-crossbow-arrow",
        initialize: () => ({}),
        acceptsContact: (context, target) =>
            target.id === context.projectile.traceTarget &&
            hasAllegiance(target) &&
            target.allegiance.side === "ALLY" &&
            hasVitality(target) &&
            target.vitality.hp > 0,
        contact: (state, context) =>
            resolveDamage(
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
                resources,
                context.call,
            ).state,
    });
}

export function create(
    profile: Profile,
    combat: CombatResources,
    timing: AttackTiming,
): { readonly definition: Definition; readonly action: CompiledAction } {
    if (profile.id !== "enemy_1003_ncbow" || profile.applyWay !== "RANGED") {
        throw new TypeError("Crossbowman content requires its ranged profile");
    }

    const projectile = timing.projectile;
    assertPositiveNumber(projectile.speedPerSecond, "enemy arrow speed");
    assertPositiveNumber(projectile.contactRadius, "enemy arrow contact radius");
    assertNonnegativeSafeInteger(projectile.stopDelayTicks, "enemy arrow stop delay");

    const definition: Definition = {
        ...createGroundDefinition(profile, timing, {
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
        }),
        profile,
        attackTiming: timing,
    };
    const action = compileAction(definition.action.normalAction, combat);
    const arrow = projectile.definition;
    const program: CompiledActionSegment[] = [
        {
            type: "EXECUTE",
            run: (state, context) => {
                const source = getUnit(state, context.sourceUnitId);
                const targetId = context.bindings.get(action.definition.triggerBindingId)?.[0];
                const target = targetId === undefined ? undefined : getUnit(state, targetId);

                if (source === undefined || target === undefined) {
                    return { state, value: { continuation: "FINISH" } };
                }

                const cachedAtk = resolveAttackPower(source.id, battlefieldView(state));

                if (cachedAtk === undefined) {
                    throw new Error("enemy arrow action requires Offense");
                }

                const launched = launchProjectile(
                    state,
                    arrow,
                    {
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
                    },
                    context.tick,
                );

                return { state: launched.state, value: undefined };
            },
        },
    ];

    return { definition, action: withTiming(action, timing, program) };
}
