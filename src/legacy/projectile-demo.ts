import { CombatResources } from "../core/tactical/battle/resources.js";
import type { BattleResources } from "../core/tactical/battle/runtime.js";
import { battlefieldView, getUnit, updateUnit } from "../core/tactical/battle/execution/context.js";
import { createProjectileDefinition } from "../core/tactical/battlefield/projectile/definition.js";
import { createShapeGeometry, type RangeGeometry } from "../core/tactical/geometry/shape.js";
import * as modifier from "../core/tactical/unit/contribution/value.js";
import { compileAction } from "../core/tactical/unit/capability/action/compile.js";
import { hasAllegiance } from "../core/tactical/unit/capability/allegiance.js";
import { apply } from "../core/tactical/unit/effect/operations.js";
import type { Definition } from "../core/tactical/unit/effect/definition.js";
import {
    hasOffense,
    setAttackContribution,
    removeAttackContribution,
    type Offense,
} from "../core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../core/tactical/unit/capability/offense/query.js";
import {
    hasStatus,
    addStatusContribution,
    removeStatusContribution,
    type Status,
} from "../core/tactical/unit/capability/status/capability.js";
import { hasVitality } from "../core/tactical/unit/capability/vitality/capability.js";
import { createDamageOperands } from "../core/tactical/unit/capability/vitality/damage/contract.js";

export function createTacticalProjectileResources(cachedOnly = false): BattleResources {
    const resources = new CombatResources();
    const marker: Definition<object, Status> = {
        id: "contact-mark",
        initialize: () => ({}),
        onEnable: (context) => {
            const unit = context.unit;
            updateUnit(context.battle, {
                ...unit,
                status: addStatusContribution(unit.status, {
                    id: `@effect/${context.self.id}/status`,
                    flags: ["HEAL_FREE"],
                }),
            });
        },
        onDisable: (context) => {
            const unit = context.unit;
            updateUnit(context.battle, {
                ...unit,
                status: removeStatusContribution(unit.status, `@effect/${context.self.id}/status`),
            });
        },
    };
    const boost: Definition<object, Offense> = {
        id: "post-launch-attack-boost",
        initialize: () => ({}),
        onEnable: (context) => {
            updateUnit(
                context.battle,
                setAttackContribution(context.unit, {
                    id: `@effect/${context.self.id}/attack`,
                    value: [modifier.create({ addition: 60 })],
                    group: { id: "demo-attack-boost", priority: 1 },
                }),
            );
        },
        onDisable: (context) => {
            updateUnit(
                context.battle,
                removeAttackContribution(context.unit, `@effect/${context.self.id}/attack`),
            );
        },
    };
    const contactRange: RangeGeometry = Object.freeze({
        type: "SHAPES",
        geometry: createShapeGeometry({
            shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.2 }],
        }),
    });
    const shell = resources.projectiles.register(
        createProjectileDefinition({
            id: cachedOnly ? "cached-atk-shell" : "live-atk-shell",
            initialize: () => ({}),
            acceptsContact: (context, target) =>
                target.id === context.projectile.traceTarget &&
                hasAllegiance(target) &&
                target.allegiance.side === "ENEMY" &&
                hasVitality(target) &&
                target.vitality.hp > 0,
            contact: (context) => {
                const target = context.facts.getUnit(context.targetUnitId);

                if (target !== undefined && hasStatus(target)) {
                    apply(context.battle, target, marker, {
                        source: context.projectile.source,
                        scopes: [{ type: "TICK", tick: context.tick + 45 }],
                    });
                }

                context.operations.damage({
                    sourceUnitId: context.projectile.source,
                    targetUnitId: context.targetUnitId,
                    damageType: "ARTS",
                    operands: createDamageOperands(
                        cachedOnly ? context.projectile.cachedAtk : context.attackPower(),
                    ),
                });
            },
        }),
    );

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
                    run: (context) => {
                        const source = getUnit(context.work, context.sourceUnitId);
                        const targetId = context.bindings.get(definition.triggerBindingId)?.[0];
                        const target =
                            targetId === undefined ? undefined : getUnit(context.work, targetId);

                        if (source === undefined || target === undefined) {
                            return { continuation: "CANCEL" };
                        }
                        if (context.projectiles === undefined) {
                            throw new Error("projectile demo requires a launch operation");
                        }

                        const cachedAtk = resolveAttackPower(
                            source.id,
                            battlefieldView(context.work),
                        );

                        if (cachedAtk === undefined || !hasOffense(source)) {
                            throw new Error("projectile demo source requires Offense capability");
                        }

                        const projectileId = context.projectiles.launch(shell.ref, {
                            source: source.id,
                            traceTarget: target.id,
                            position: source.position,
                            destination: target.position,
                            cachedAtk,
                            speedPerTick: 0.12,
                            contactRange,
                            stopDelayTicks: 6,
                        });
                        apply(context.work, source, boost, {
                            source: source.id,
                            scopes: [{ type: "TICK", tick: context.tick + 70 }],
                        });

                        return { samples: { cachedAtk, projectileId } };
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
