import { Definitions } from "../../../core/tactical/unit/action/definitions.js";
import { create as createAttack, type Attack } from "../actions/attack.js";
import { calculateDamage } from "../../../core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../../core/tactical/battle/damage/apply.js";
import type { DamageRequest } from "../../../core/tactical/battle/damage/contract.js";
import type { Ref } from "../../../core/common/ref.js";
import * as units from "../../../core/tactical/unit/query.js";
import type { Profile } from "../../../data/arknights/enemy.js";
import { perSecondToPerTick } from "../../../data/arknights/tick.js";
import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../../core/common/assert.js";
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
import { resolveAttackPower } from "../../../core/tactical/unit/capability/offense/query.js";
import { hasVitality } from "../../../core/tactical/unit/capability/vitality/capability.js";
import type { Unit } from "../../../core/tactical/unit/unit.js";
import type { Product } from "../../../core/tactical/unit/capability/catalog.js";
import {
    createDefinition as createGroundDefinition,
    type AttackTiming as GroundAttackTiming,
    type Definition as GroundDefinition,
} from "./ground.js";

export interface Projectile {
    readonly definition: ProjectileDefinition<ProjectileState>;
    readonly speedPerSecond: number;
    readonly contactRadius: number;
    readonly stopDelayTicks: number;
}

interface ProjectileState {
    readonly source: Ref<Unit> | null;
}

export interface AttackTiming extends GroundAttackTiming {
    readonly projectile: Projectile;
}

export interface Definition extends GroundDefinition {
    readonly profile: Profile;
    readonly attackTiming: AttackTiming;
}

export type Enemy = Unit & Product<Definition>;

export function createArrow(): ProjectileDefinition<ProjectileState> {
    return createProjectileDefinition({
        id: "main-mode-crossbow-arrow",
        initialize: (): ProjectileState => ({ source: null }),
        acceptsContact: (context, target) =>
            target.id === context.projectile.traceTarget &&
            hasAllegiance(target) &&
            target.allegiance.side === "ALLY" &&
            hasVitality(target) &&
            target.vitality.hp > 0,
        contact: (state, context) => {
            const target = getUnit(state, context.targetUnitId);

            if (target === undefined || !hasVitality(target)) {
                return state;
            }

            const request: DamageRequest = {
                source: context.projectile.state.source,
                target: units.ref(target),
                parameters: {
                    type: "PHYSICAL",
                    attack: {
                        power: resolveProjectileAttackPower(state, context.projectile),
                        multiplier: 1,
                        addition: 0,
                    },
                    penetration: { fixed: 0, proportional: 0 },
                },
            };

            return applyDamage(request, calculateDamage(state, request)).state;
        },
    });
}

export function create(
    profile: Profile,
    timing: AttackTiming,
): { readonly definition: Definition; readonly action: Attack } {
    if (profile.id !== "enemy_1003_ncbow" || profile.applyWay !== "RANGED") {
        throw new TypeError("Crossbowman content requires its ranged profile");
    }

    const projectile = timing.projectile;
    assertPositiveNumber(projectile.speedPerSecond, "enemy arrow speed");
    assertPositiveNumber(projectile.contactRadius, "enemy arrow contact radius");
    assertNonnegativeSafeInteger(projectile.stopDelayTicks, "enemy arrow stop delay");

    const ground = createGroundDefinition(profile, timing, {
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
    });
    const arrow = projectile.definition;
    const action = createAttack({
        ...ground.attack.attack,
        output: (state, self) => {
            const source = getUnit(state, self.source.id);
            const targetId = self.state.target.id;
            const target = getUnit(state, targetId);

            if (source === undefined || target === undefined) {
                return state;
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
                    initialState: { source: units.ref(source) },
                },
                state.tick,
            );

            return launched.state;
        },
    });
    const definition: Definition = {
        ...ground,
        profile,
        attackTiming: timing,
        attack: action,
        action: { definitions: Definitions.empty().add(action) },
    };

    return { definition, action };
}
