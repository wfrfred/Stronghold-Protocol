import type { Input } from "../core/tactical/battle/contract.js";
import type { FragmentDefinition } from "../core/tactical/battle/schedule/definition.js";
import type { Definition as UnitDefinition } from "../core/tactical/unit/unit.js";
import { Definitions } from "../core/tactical/unit/action/definitions.js";
import { hasActionDefinition } from "../core/tactical/unit/capability/action/capability.js";
import { create as createAttack, isAttack } from "../content/tactical/actions/attack.js";
import { resolveDamage } from "../core/tactical/unit/capability/vitality/damage/settlement.js";
import { ref as unitRef } from "../core/tactical/unit/query.js";

import { battlefieldView, getUnit, updateUnit } from "../core/tactical/battle/state.js";
import {
    launchProjectile,
    resolveProjectileAttackPower,
} from "../core/tactical/battlefield/projectile/operations.js";
import { createDefinition as createProjectileDefinition } from "../core/tactical/battlefield/projectile/definition.js";
import { createShapeGeometry, type RangeGeometry } from "../core/tactical/geometry/shape.js";
import * as modifier from "../core/tactical/unit/contribution/value.js";
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

export function createTacticalProjectileDemo(
    input: Input,
    cachedOnly = false,
): { readonly input: Input } {
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

            return resolveDamage(
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

    function transform<D extends UnitDefinition>(definition: D): D {
        if (!hasActionDefinition(definition)) {
            return definition;
        }

        let definitions = Definitions.empty();

        for (const id of definition.action.definitions.keys()) {
            definition.action.definitions.read(id, (current) => {
                if (!isAttack(current)) {
                    definitions = definitions.add(current);

                    return;
                }

                const attack = createAttack({
                    ...current.attack,
                    windupTicks: 6,
                    recoveryTicks: 6,
                    markerId: "demo-shell",
                    output: (state, self) => {
                        const source = getUnit(state, self.source.id);
                        const targetId = self.state.target.id;
                        const target = getUnit(state, targetId);

                        if (source === undefined || target === undefined) {
                            return state;
                        }

                        const cachedAtk = resolveAttackPower(source.id, battlefieldView(state));

                        if (cachedAtk === undefined || !hasOffense(source)) {
                            throw new Error("projectile demo source requires Offense capability");
                        }

                        const launched = launchProjectile(
                            state,
                            shell,
                            {
                                source: source.id,
                                traceTarget: target.id,
                                position: source.position,
                                destination: target.position,
                                cachedAtk,
                                speedPerTick: 0.12,
                                contactRange,
                                stopDelayTicks: 6,
                            },
                            state.tick,
                        );
                        state = install(launched.state, unitRef(source), boost, {
                            source: source.id,
                            scopes: [{ type: "TICK", tick: state.tick + 70 }],
                        }).state;

                        return state;
                    },
                });
                definitions = definitions.add(attack);
            });
        }

        return { ...definition, action: { ...definition.action, definitions } };
    }

    const fragment = (value: FragmentDefinition): FragmentDefinition => ({
        ...value,
        actions: value.actions.map((action) => ({
            ...action,
            spawn: { ...action.spawn, definition: transform(action.spawn.definition) },
        })),
    });
    const schedule =
        input.schedule.type === "TIMELINE"
            ? {
                  ...input.schedule,
                  spawns: input.schedule.spawns.map((spawn) => ({
                      ...spawn,
                      definition: transform(spawn.definition),
                  })),
              }
            : {
                  ...input.schedule,
                  waves: input.schedule.waves.map((wave) => ({
                      ...wave,
                      fragments: wave.fragments.map(fragment),
                  })),
                  branches: Object.fromEntries(
                      Object.entries(input.schedule.branches).map(([id, branch]) => [
                          id,
                          { ...branch, phases: branch.phases.map(fragment) },
                      ]),
                  ),
              };

    return {
        input: {
            ...input,
            schedule,
            initialUnits: input.initialUnits.map((unit) => ({
                ...unit,
                definition: transform(unit.definition),
            })),
        },
    };
}
