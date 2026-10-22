import type { Input } from "../core/tactical/battle/contract.js";
import type { FragmentDefinition } from "../core/tactical/battle/schedule/definition.js";
import type { Definition as UnitDefinition } from "../core/tactical/unit/unit.js";
import { Definitions } from "../core/tactical/unit/action/definitions.js";
import { hasActionDefinition } from "../core/tactical/unit/capability/action/capability.js";
import { create as createAttack, isAttack } from "../content/tactical/actions/attack.js";
import { calculateDamage } from "../core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../core/tactical/battle/damage/apply.js";
import type { DamageRequest } from "../core/tactical/battle/damage/contract.js";
import { ref as unitRef } from "../core/tactical/unit/query.js";
import * as tracking from "../content/tactical/projectiles/tracking.js";

import { getUnit, updateUnit, type State as BattleState } from "../core/tactical/battle/state.js";
import type { Projectile } from "../core/tactical/battlefield/projectile/projectile.js";
import { create as createProjectile } from "../core/tactical/battlefield/projectile/operations.js";
import * as attribute from "../core/tactical/unit/contribution/attribute.js";
import { install } from "../core/tactical/unit/effect/operations.js";
import type { Definition } from "../core/tactical/unit/effect/definition.js";
import {
    hasOffense,
    setAttackContribution,
    removeAttackContribution,
    type Offense,
} from "../core/tactical/unit/capability/offense/capability.js";
import { resolveAttack } from "../core/tactical/unit/capability/offense/query.js";
import { healFree } from "../content/tactical/effects/protection.js";
import { hasVitality } from "../core/tactical/unit/capability/vitality/capability.js";
import { hasTargetable } from "../core/tactical/unit/capability/targetable/capability.js";

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
                    value: [attribute.create({ addition: 60 })],
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
    const hit = (battle: BattleState, self: Projectile<tracking.State>): BattleState =>
        tracking.hit(battle, self, (state, current, target) => {
            if (hasTargetable(target)) {
                state = install(state, unitRef(target), marker, {
                    source: current.state.source?.id ?? null,
                    scopes: [{ type: "TICK", tick: state.tick + 45 }],
                }).state;
            }

            const receiver = getUnit(state, target.id);

            if (
                receiver?.lifecycle !== "PRESENT" ||
                !hasVitality(receiver) ||
                receiver.vitality.hp <= 0
            ) {
                return state;
            }

            const request: DamageRequest = {
                source: current.state.source,
                target: unitRef(receiver),
                parameters: {
                    type: "ARTS",
                    attack: {
                        power: cachedOnly
                            ? current.state.cachedAtk
                            : tracking.attackPower(state, current),
                        multiplier: 1,
                        addition: 0,
                    },
                    penetration: { fixed: 0, proportional: 0 },
                },
            };

            return applyDamage(request, calculateDamage(state, request)).state;
        });
    const shell: tracking.Definition = {
        id: cachedOnly ? "cached-atk-shell" : "live-atk-shell",
        tracking: true,
        onAdvance: (battle, self) => tracking.advance(battle, self, hit),
        onTerminate: (battle, self, reason) => (reason === "DISPEL" ? battle : hit(battle, self)),
    };

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
                        const source = getUnit(state, self.host.id);
                        const targetId = self.state.target.id;
                        const target = getUnit(state, targetId);

                        if (source === undefined || target === undefined || !hasVitality(target)) {
                            return state;
                        }

                        if (!hasOffense(source)) {
                            throw new Error("projectile demo source requires Offense capability");
                        }

                        const cachedAtk = resolveAttack(state, unitRef(source))!;

                        const launched = createProjectile(state, shell, {
                            position: source.position,
                            state: {
                                source: unitRef(source),
                                target: unitRef(target),
                                destination: target.position,
                                cachedAtk,
                                speedPerTick: 0.12,
                                stopDelayTicks: 6,
                                stopAtTick: null,
                                hitAttempted: false,
                                launchedAtTick: state.tick,
                            },
                        });
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
