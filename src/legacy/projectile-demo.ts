import { ref as unitRef } from "../core/tactical/unit/query.js";
import { CombatResources } from "../core/tactical/battle/resources.js";
import type { BattleResources } from "../core/tactical/battle/runtime.js";
import { battlefieldView, getUnit, updateUnit } from "../core/tactical/battle/state.js";
import { resolveProjectileAttackPower } from "../core/tactical/battlefield/projectile/operations.js";
import { createDefinition as createProjectileDefinition } from "../core/tactical/battlefield/projectile/definition.js";
import { createShapeGeometry, type RangeGeometry } from "../core/tactical/geometry/shape.js";
import * as modifier from "../core/tactical/unit/contribution/value.js";
import { compileAction } from "../core/tactical/unit/capability/action/compile.js";
import { hasAllegiance } from "../core/tactical/unit/capability/allegiance/capability.js";
import { install } from "../core/tactical/unit/effect/operations.js";
import type { Definition } from "../core/tactical/unit/effect/definition.js";
import {
    hasOffense,
    setAttackContribution,
    removeAttackContribution,
    type Offense,
} from "../core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../core/tactical/unit/capability/offense/query.js";
import { healFree } from "../content/tactical/effects/protection.js";
import { hasVitality } from "../core/tactical/unit/capability/vitality/capability.js";
import { createDamageOperands } from "../core/tactical/unit/capability/vitality/damage/contract.js";

export function createTacticalProjectileResources(cachedOnly = false): BattleResources {
    const resources = new CombatResources();
    const marker = { ...healFree, id: "contact-mark" };
    const boost: Definition<object, Offense> = {
        id: "post-launch-attack-boost",
        initialize: () => ({}),
        onEnable: (state, context) => {
            return updateUnit(state, {
                ...context.unit,
                offense: setAttackContribution(context.unit.offense, {
                    id: `@effect/${context.self.id}/attack`,
                    value: [modifier.create({ addition: 60 })],
                    group: { id: "demo-attack-boost", priority: 1 },
                }),
            });
        },
        onDisable: (state, context) => {
            return updateUnit(state, {
                ...context.unit,
                offense: removeAttackContribution(
                    context.unit.offense,
                    `@effect/${context.self.id}/attack`,
                ),
            });
        },
    };
    const contactRange: RangeGeometry = Object.freeze({
        type: "SHAPES",
        geometry: createShapeGeometry({
            shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.2 }],
        }),
    });
    const shell = createProjectileDefinition({
        id: cachedOnly ? "cached-atk-shell" : "live-atk-shell",
        initialize: () => ({}),
        acceptsContact: (context, target) =>
            target.id === context.projectile.traceTarget &&
            hasAllegiance(target) &&
            target.allegiance.side === "ENEMY" &&
            hasVitality(target) &&
            target.vitality.hp > 0,
        contact: (state, context) => {
            const target = context.facts.getUnit(context.targetUnitId);

            if (target !== undefined) {
                state = install(
                    state,
                    unitRef(target),
                    marker,
                    {
                        source: context.projectile.source,
                        scopes: [{ type: "TICK", tick: context.tick + 45 }],
                    },
                    context.call,
                ).state;
            }

            return resources.settleDamage(
                state,
                {
                    sourceUnitId: context.projectile.source,
                    targetUnitId: context.targetUnitId,
                    tick: context.tick,
                    damageType: "ARTS",
                    operands: createDamageOperands(
                        cachedOnly
                            ? context.projectile.cachedAtk
                            : resolveProjectileAttackPower(state, context.projectile),
                    ),
                },
                context.call,
            ).state;
        },
    });

    return {
        combat: resources,
        compileAction: (definition) => ({
            ...compileAction(definition, resources),
            program: [
                {
                    type: "WAIT",
                    allowNewAction: false,
                    resolve: () => ({ type: "FOR_TICKS", ticks: 6 }),
                },
                { type: "RELEASE", markerId: "demo-shell" },
                {
                    type: "EXECUTE",
                    run: (state, context) => {
                        const source = getUnit(state, context.sourceUnitId);
                        const targetId = context.bindings.get(definition.triggerBindingId)?.[0];
                        const target =
                            targetId === undefined ? undefined : getUnit(state, targetId);

                        if (source === undefined || target === undefined) {
                            return { state, value: { continuation: "CANCEL" } };
                        }
                        if (context.projectiles === undefined) {
                            throw new Error("projectile demo requires a launch operation");
                        }

                        const cachedAtk = resolveAttackPower(source.id, battlefieldView(state));

                        if (cachedAtk === undefined || !hasOffense(source)) {
                            throw new Error("projectile demo source requires Offense capability");
                        }

                        const launched = context.projectiles.launch(state, shell, {
                            source: source.id,
                            traceTarget: target.id,
                            position: source.position,
                            destination: target.position,
                            cachedAtk,
                            speedPerTick: 0.12,
                            contactRange,
                            stopDelayTicks: 6,
                        });
                        state = install(
                            launched.state,
                            unitRef(source),
                            boost,
                            {
                                source: source.id,
                                scopes: [{ type: "TICK", tick: context.tick + 70 }],
                            },
                            context.call,
                        ).state;

                        return {
                            state,
                            value: { samples: { cachedAtk, projectileId: launched.value.id } },
                        };
                    },
                },
                {
                    type: "WAIT",
                    allowNewAction: false,
                    resolve: () => ({ type: "FOR_TICKS", ticks: 6 }),
                },
            ],
        }),
    };
}
