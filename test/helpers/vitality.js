import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { transitionUnit, getUnit, battlefieldView } from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { find } from "../../dist/core/tactical/unit/effect/query.js";
import * as damage from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import * as healing from "../../dist/core/tactical/unit/capability/vitality/healing/hook.js";
import {
    addStatusContribution,
    removeStatusContribution,
} from "../../dist/core/tactical/unit/capability/status/capability.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { definition, effectFixtureWork, installFixtureEffect } from "./effects.js";

export { effectFixtureWork as workFor, installFixtureEffect as attach };

export function unit(
    id,
    { hp = 5000, maxHp = hp, attack = 100, defense = 0, resistance = 0, flags = [] } = {},
) {
    const value = initializeUnit({
        id,
        position: [0, 0],
        definition: {
            id: `vitality-${id}`,
            vitality: { maxHp },
            offense: { attack },
            defense: { defense, resistance },
            status: { initialFlags: flags },
        },
    });
    return { ...value, vitality: { ...value.vitality, hp } };
}

export function request(power = 100, overrides = {}) {
    return {
        sourceUnitId: 1,
        targetUnitId: 2,
        damageType: "PHYSICAL",
        operands: createDamageOperands(power),
        tick: 12,
        ...overrides,
    };
}

export function setSelf(state, context, self, next) {
    const unit = getUnit(state, context.unit.id);
    const current = unit && find(unit, self.definition, self.id);
    return current === undefined
        ? state
        : effects.replaceEffect(state, unit.id, effects.setState(current, next));
}

export function current(state, context, self) {
    const unit = getUnit(state, context.unit.id);
    return unit && find(unit, self.definition, self.id);
}

function hookEffect(domain, id, initial, entries, callbacks = {}) {
    let content;
    content = definition(id, initial, {
        ...callbacks,
        onInstall(state, context) {
            state = transitionUnit(state, context.ref.unitId, (unit) =>
                entries.reduce(
                    (unit, entry, index) =>
                        domain.setHook(unit, {
                            id: `${context.ref.unitId}:${context.ref.effectId}:${index}`,
                            stage: entry.stage,
                            priority: entry.priority ?? 0,
                            enabled(invocation) {
                                const self = find(invocation.unit, content, context.ref.effectId);
                                return (
                                    self?.status === "ACTIVE" &&
                                    (entry.enabled?.(invocation, self) ?? true)
                                );
                            },
                            invoke(state, invocation, input) {
                                return entry.invoke(
                                    state,
                                    invocation,
                                    find(invocation.unit, content, context.ref.effectId),
                                    input,
                                );
                            },
                        }),
                    unit,
                ),
            );
            return callbacks.onInstall ? callbacks.onInstall(state, context) : state;
        },
        onEnd(state, context) {
            state = transitionUnit(state, context.ref.unitId, (unit) =>
                entries.reduce(
                    (unit, _entry, index) =>
                        domain.removeHook(
                            unit,
                            `${context.ref.unitId}:${context.ref.effectId}:${index}`,
                        ),
                    unit,
                ),
            );
            return callbacks.onEnd ? callbacks.onEnd(state, context) : state;
        },
    });
    return content;
}

export function damageEffect(id, initial, entries, callbacks) {
    return hookEffect(damage, id, initial, entries, callbacks);
}

export function healingEffect(id, initial, entries, callbacks) {
    return hookEffect(healing, id, initial, entries, callbacks);
}

export function barrier(id = "barrier", remainingAmount = 500, priority = 0) {
    return damageEffect(id, { remainingAmount }, [
        {
            stage: "reception",
            priority,
            invoke(state, context, self, pending) {
                if (pending.cancellation !== null) return { state, value: { value: pending } };
                const absorbed = Math.min(pending.amount, self.state.remainingAmount);
                if (absorbed <= 0) return { state, value: { value: pending } };
                state = setSelf(state, context, self, (state) => ({
                    ...state,
                    remainingAmount: state.remainingAmount - absorbed,
                }));
                return {
                    state,
                    value: {
                        value: {
                            ...pending,
                            amount: pending.amount - absorbed,
                            consumptions: [
                                ...pending.consumptions,
                                {
                                    ownerUnitId: context.unit.id,
                                    resourceId: `${context.unit.id}:${self.id}`,
                                    resource: "barrier",
                                    amount: absorbed,
                                },
                            ],
                        },
                    },
                };
            },
        },
    ]);
}

export function statusEffect(id, flags) {
    return definition(
        id,
        {},
        {
            onEnable(state, context) {
                return transitionUnit(state, context.ref.unitId, (unit) => ({
                    ...unit,
                    status: addStatusContribution(unit.status, {
                        id: `${context.ref.unitId}:${context.ref.effectId}`,
                        flags,
                    }),
                }));
            },
            onDisable(state, context) {
                return transitionUnit(state, context.ref.unitId, (unit) => ({
                    ...unit,
                    status: removeStatusContribution(
                        unit.status,
                        `${context.ref.unitId}:${context.ref.effectId}`,
                    ),
                }));
            },
        },
    );
}

export function stateOf(battle, unitId, content) {
    return getUnit(battle, unitId).effects.instances.find(
        (instance) => instance.definition === content,
    )?.state;
}

export const view = battlefieldView;
