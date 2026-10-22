import { Definitions } from "../../../core/tactical/unit/action/definitions.js";
import { create as createAttack, type Attack } from "../actions/attack.js";
import { calculateDamage } from "../../../core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../../core/tactical/battle/damage/apply.js";
import type { DamageRequest } from "../../../core/tactical/battle/damage/contract.js";
import * as units from "../../../core/tactical/unit/query.js";
import type { Profile } from "../../../data/arknights/enemy.js";
import { perSecondToPerTick } from "../../../data/arknights/tick.js";
import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../../core/common/assert.js";
import { create as createProjectile } from "../../../core/tactical/battlefield/projectile/operations.js";
import type { Projectile as ProjectileInstance } from "../../../core/tactical/battlefield/projectile/projectile.js";
import type { State as BattleState } from "../../../core/tactical/battle/state.js";
import * as tracking from "../projectiles/tracking.js";
import { hasOffense } from "../../../core/tactical/unit/capability/offense/capability.js";
import { resolveAttack } from "../../../core/tactical/unit/capability/offense/query.js";
import { hasVitality } from "../../../core/tactical/unit/capability/vitality/capability.js";
import type { Unit } from "../../../core/tactical/unit/unit.js";
import type { Product } from "../../../core/tactical/unit/capability/catalog.js";
import {
    createDefinition as createGroundDefinition,
    type AttackTiming as GroundAttackTiming,
    type Definition as GroundDefinition,
} from "./ground.js";

export interface Projectile {
    readonly definition: tracking.Definition;
    readonly speedPerSecond: number;
    readonly stopDelayTicks: number;
}

export interface AttackTiming extends GroundAttackTiming {
    readonly projectile: Projectile;
}

export interface Definition extends GroundDefinition {
    readonly profile: Profile;
    readonly attackTiming: AttackTiming;
}

export type Enemy = Unit & Product<Definition>;

export function createArrow(): tracking.Definition {
    const hit = (battle: BattleState, self: ProjectileInstance<tracking.State>): BattleState =>
        tracking.hit(battle, self, (state, current, target) => {
            const source = current.state.source;
            const request: DamageRequest = {
                source: source !== null && units.get(state, source) !== undefined ? source : null,
                target: units.ref(target),
                parameters: {
                    type: "PHYSICAL",
                    attack: {
                        power: tracking.attackPower(state, current),
                        multiplier: 1,
                        addition: 0,
                    },
                    penetration: { fixed: 0, proportional: 0 },
                },
            };

            return applyDamage(request, calculateDamage(state, request)).state;
        });

    return {
        id: "main-mode-crossbow-arrow",
        tracking: true,
        onAdvance: (battle, self) => tracking.advance(battle, self, hit),
        onTerminate: (battle, self, reason) => (reason === "DISPEL" ? battle : hit(battle, self)),
    };
}

export function create(
    profile: Profile,
    timing: AttackTiming,
    halfBodyWidth: number,
): { readonly definition: Definition; readonly action: Attack } {
    if (profile.id !== "enemy_1003_ncbow" || profile.applyWay !== "RANGED") {
        throw new TypeError("Crossbowman content requires its ranged profile");
    }

    const projectile = timing.projectile;
    assertPositiveNumber(projectile.speedPerSecond, "enemy arrow speed");
    assertNonnegativeSafeInteger(projectile.stopDelayTicks, "enemy arrow stop delay");

    const ground = createGroundDefinition(
        profile,
        timing,
        {
            type: "RANGE",
            geometry: [
                {
                    type: "CIRCLE",
                    offset: [0, 0],
                    radius: profile.rangeRadius,
                },
            ],
        },
        halfBodyWidth,
    );
    const arrow = projectile.definition;
    const action = createAttack({
        ...ground.attack.attack,
        output: (state, self) => {
            const source = units.get(state, self.host);
            const target = units.get(state, self.state.target);

            if (source === undefined || target === undefined || !hasVitality(target)) {
                return state;
            }

            const cachedAtk = hasOffense(source) ? resolveAttack(state, units.ref(source)) : 0;

            if (cachedAtk === undefined) {
                throw new Error("enemy arrow action requires Offense");
            }

            const launched = createProjectile(state, arrow, {
                position: source.position,
                state: {
                    source: units.ref(source),
                    target: units.ref(target),
                    destination: target.position,
                    cachedAtk,
                    speedPerTick: perSecondToPerTick(projectile.speedPerSecond),
                    stopDelayTicks: projectile.stopDelayTicks,
                    stopAtTick: null,
                    hitAttempted: false,
                    launchedAtTick: state.tick,
                },
            });

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
