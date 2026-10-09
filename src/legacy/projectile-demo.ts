import { computedAttack } from "../core/tactical/unit/capability/offense/contributions.js";
import { CombatResources } from "../core/tactical/battle/resources.js";
import type { BattleResources } from "../core/tactical/battle/runtime.js";
import { combatWorkView, getCombatUnit } from "../core/tactical/battle/execution/work.js";
import { createProjectileProgram } from "../core/tactical/battlefield/projectile/program.js";
import { createShapeGeometry, type RangeGeometry } from "../core/tactical/geometry/shape.js";
import * as modifier from "../core/tactical/modifier/value.js";
import { compileAction } from "../core/tactical/unit/capability/action/compile.js";
import { hasAllegiance } from "../core/tactical/unit/capability/allegiance.js";
import { installNewEffect } from "../core/tactical/unit/capability/effects/lifecycle.js";
import { createEffectProgram } from "../core/tactical/unit/capability/effects/program.js";
import { resolveAttackPower } from "../core/tactical/unit/capability/offense/query.js";
import { compileStatusBinding } from "../core/tactical/unit/capability/status/binding.js";
import { hasVitality } from "../core/tactical/unit/capability/vitality/capability.js";
import { createDamageOperands } from "../core/tactical/unit/capability/vitality/damage/contract.js";

export function createTacticalProjectileResources(cachedOnly = false): BattleResources {
    const resources = new CombatResources();
    const marker = resources.registerEffect(
        createEffectProgram({
            id: "contact-mark",
            initialize: () => ({}),
            ownState: () => ({}),
        }),
        { bindings: [compileStatusBinding(["HEAL_FREE"])] },
    );
    const boost = resources.registerEffect(
        createEffectProgram({
            id: "post-launch-attack-boost",
            initialize: () => ({}),
            ownState: () => ({}),
        }),
        {
            contributions: [
                computedAttack(() => [modifier.create({ addition: 60 })], {
                    group: { id: "demo-attack-boost", strength: 1 },
                }),
            ],
        },
    );
    const contactRange: RangeGeometry = Object.freeze({
        type: "SHAPES",
        geometry: createShapeGeometry({
            shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.2 }],
        }),
    });
    const shell = resources.projectiles.register(
        createProjectileProgram({
            id: cachedOnly ? "cached-atk-shell" : "live-atk-shell",
            initialize: () => ({}),
            ownState: () => ({}),
            acceptsContact: (context, target) =>
                target.id === context.projectile.traceTarget &&
                hasAllegiance(target) &&
                target.allegiance.side === "ENEMY" &&
                hasVitality(target) &&
                target.vitality.hp > 0,
            contact: (context) => {
                context.operations.effects.install(context.targetUnitId, marker.ref, {
                    source: context.projectile.source,
                    scopes: [{ type: "TICK", tick: context.tick + 45 }],
                });
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
                        const source = getCombatUnit(context.work, context.sourceUnitId);
                        const targetId = context.bindings.get(definition.triggerBindingId)?.[0];
                        const target =
                            targetId === undefined
                                ? undefined
                                : getCombatUnit(context.work, targetId);

                        if (source === undefined || target === undefined) {
                            return { work: context.work, continuation: "CANCEL" };
                        }
                        if (context.projectiles === undefined) {
                            throw new Error("projectile demo requires a launch operation");
                        }

                        const cachedAtk = resolveAttackPower(
                            source.id,
                            combatWorkView(context.work),
                            resources.computations,
                        );

                        if (cachedAtk === undefined) {
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
                        const work = installNewEffect(
                            context.work,
                            source.id,
                            boost.ref,
                            {
                                source: source.id,
                                scopes: [{ type: "TICK", tick: context.tick + 70 }],
                            },
                            resources,
                            context.tick,
                        ).work;

                        return { work, samples: { cachedAtk, projectileId } };
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
