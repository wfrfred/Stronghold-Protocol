import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import { initialize } from "./unit.js";
import { transitionUnit, getUnit, battlefieldView } from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import * as damageHooks from "../../dist/core/tactical/battle/damage/hook.js";
import * as healingHooks from "../../dist/core/tactical/battle/healing/hook.js";
import { calculateHealing } from "../../dist/core/tactical/battle/healing/calculate.js";
import { applyHealing } from "../../dist/core/tactical/battle/healing/apply.js";
import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../dist/core/tactical/battle/damage/apply.js";
import { definition, effectFixtureWork, installFixtureEffect } from "./effects.js";

export { effectFixtureWork as workFor, installFixtureEffect as attach };

export function unit(
    id,
    { hp = 5000, maxHp = hp, attack = 100, defense = 0, resistance = 0, vitality = {} } = {},
) {
    const value = initialize({
        id,
        position: [0, 0],
        definition: {
            id: `vitality-${id}`,
            vitality: { maxHp, defense, resistance },
            targetable: { restrictions: [] },
            offense: { attack },
        },
    });
    return { ...value, vitality: { ...value.vitality, hp, ...vitality } };
}

export function parameters(power, type = "PHYSICAL", penetration = { fixed: 0, proportional: 0 }) {
    const attack = { power, multiplier: 1, addition: 0 };
    return type === "PHYSICAL" || type === "ARTS"
        ? { type, attack, penetration }
        : { type, attack };
}

export function request(power = 100, overrides = {}) {
    return {
        source: { id: 1 },
        target: { id: 2 },
        parameters: parameters(power),
        ...overrides,
    };
}

export function damage(battle, request) {
    return applyDamage(request, calculateDamage(battle, request));
}

export function healingParameters(power, multiplier = 1) {
    return { power, multiplier };
}

export function healing(battle, request) {
    return applyHealing(request, calculateHealing(battle, request));
}

export function setSelf(state, context, self, next) {
    const unit = getUnit(state, context.host.id);
    const current = unit && unit.effects.get(self.id, self.definition);
    return current === undefined
        ? state
        : effects.replaceEffect(
              state,
              { host: current.host, id: current.id },
              setData(current, next),
          );
}

export function current(state, context, self) {
    const unit = getUnit(state, context.host.id);
    return unit && unit.effects.get(self.id, self.definition);
}

function hookEffect(domain, id, initial, entries, callbacks = {}) {
    let content;
    content = definition(id, initial, {
        ...callbacks,
        onInstall(state, context) {
            state = transitionUnit(state, context.ref.host.id, (unit) =>
                entries.reduce(
                    (unit, entry, index) => ({
                        ...unit,
                        vitality: domain.setHook(unit.vitality, {
                            id: `${context.ref.host.id}:${context.ref.id}:${index}`,
                            stage: entry.stage,
                            priority: entry.priority ?? 0,
                            accepts(state, contextValue, input) {
                                const invocation = { ...contextValue, host: context.ref.host };
                                const self = getUnit(state, invocation.host.id)?.effects.get(context.ref.id, content);
                                return (
                                    self?.status === "ACTIVE" &&
                                    (entry.accepts?.(state, invocation, self, input) ?? true)
                                );
                            },
                            invoke(state, contextValue, input) {
                                const invocation = { ...contextValue, host: context.ref.host };
                                return entry.invoke(
                                    state,
                                    invocation,
                                    getUnit(state, invocation.host.id).effects.get(context.ref.id, content),
                                    input,
                                );
                            },
                        }),
                    }),
                    unit,
                ),
            );
            return callbacks.onInstall ? callbacks.onInstall(state, context) : state;
        },
        onEnd(state, context) {
            state = transitionUnit(state, context.ref.host.id, (unit) =>
                entries.reduce(
                    (unit, _entry, index) => ({
                        ...unit,
                        vitality: domain.removeHook(
                            unit.vitality,
                            `${context.ref.host.id}:${context.ref.id}:${index}`,
                        ),
                    }),
                    unit,
                ),
            );
            return callbacks.onEnd ? callbacks.onEnd(state, context) : state;
        },
    });
    return content;
}

export function damageEffect(id, initial, entries, callbacks) {
    return hookEffect(damageHooks, id, initial, entries, callbacks);
}

export function healingEffect(id, initial, entries, callbacks) {
    return hookEffect(healingHooks, id, initial, entries, callbacks);
}

export function barrier(id = "barrier", remainingAmount = 500, priority = 0) {
    return damageEffect(id, { remainingAmount }, [
        {
            stage: "receiving",
            priority,
            invoke(state, context, self, pending) {
                if (pending.cancellation !== null) return { state, value: pending };
                const absorbed = Math.min(pending.amount, self.data.remainingAmount);
                if (absorbed <= 0) return { state, value: pending };
                state = setSelf(state, context, self, (state) => ({
                    ...state,
                    remainingAmount: state.remainingAmount - absorbed,
                }));
                return {
                    state,
                    value: {
                        ...pending,
                        amount: pending.amount - absorbed,
                    },
                };
            },
        },
    ]);
}

export function stateOf(battle, unitId, content) {
    return getUnit(battle, unitId)
        .effects.values()
        .find((instance) => instance.definition === content)?.data;
}

export const view = battlefieldView;
