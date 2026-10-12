import { fixtureBattlefieldState as fixtureBattlefield } from "./battlefield.js";
import {
    createBattleState,
    battlefieldView,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";
import {
    setAttackContribution,
    removeAttackContribution,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import {
    setMaxHpContribution,
    removeMaxHpContribution,
} from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/value.js";

export function effectFixtureWork(...units) {
    const byId = new Map(units.map((unit) => [unit.id, unit]));

    return createBattleState(
        fixtureBattlefield({
            unitIds: [...byId.keys()],
            getUnit: (id) => byId.get(id),
            blockerOf: () => undefined,
            blockedBy: () => [],
        }),
    );
}

export function installFixtureEffect(unit, definition, initial = {}, tick = 0) {
    const state = effectFixtureWork(unit);
    const installed = effects.install({ ...state, tick }, unit, definition, initial);
    return getUnit(installed.state, unit.id);
}

export const definition = (id, initial = {}, callbacks = {}) => ({
    id,
    initialize: () => initial,
    ...callbacks,
});

export function install(
    state,
    definition,
    unitId = [...state.battlefield.units.keys()][0],
    initial = {},
) {
    return effects.install(state, getUnit(state, unitId), definition, initial);
}

export function at(state, tick) {
    return { ...state, tick };
}

export function attackBuff(id = "attack-buff", amount = 20, callbacks = {}) {
    return contributionBuff(id, amount, setAttackContribution, removeAttackContribution, callbacks);
}

export function maxHpBuff(id = "max-hp-buff", amount = 100, callbacks = {}) {
    return contributionBuff(id, amount, setMaxHpContribution, removeMaxHpContribution, callbacks);
}

function contributionBuff(id, amount, set, remove, callbacks) {
    return definition(
        id,
        { amount },
        {
            ...callbacks,
            onEnable(state, context) {
                state = transitionUnit(state, context.ref.unitId, (unit) =>
                    set(unit, {
                        id: `${context.ref.unitId}:${context.ref.effectId}`,
                        value: [modifier({ finalAddition: context.self.state.amount })],
                    }),
                );
                return callbacks.onEnable ? callbacks.onEnable(state, context) : state;
            },
            onDisable(state, context) {
                state = transitionUnit(state, context.ref.unitId, (unit) =>
                    remove(unit, `${context.ref.unitId}:${context.ref.effectId}`),
                );
                return callbacks.onDisable ? callbacks.onDisable(state, context) : state;
            },
        },
    );
}

export function refreshAttack(state, ref) {
    const instance = get(state, ref);
    if (instance?.status !== "ACTIVE") return state;
    return transitionUnit(state, ref.unitId, (unit) =>
        setAttackContribution(unit, {
            id: `${ref.unitId}:${ref.effectId}`,
            value: [modifier({ finalAddition: instance.state.amount })],
        }),
    );
}

export function contributionEffect(
    id,
    initial,
    { set, remove, value, group, dynamic = false },
    callbacks = {},
) {
    let content;
    const key = (ref) => `${ref.unitId}:${ref.effectId}`;
    const publish = (state, context) =>
        transitionUnit(state, context.ref.unitId, (unit) =>
            set(unit, {
                id: key(context.ref),
                ...(group === undefined
                    ? {}
                    : { group: typeof group === "function" ? group(context.self) : group }),
                value: dynamic
                    ? (query) => {
                          const current = query.unit.effects.instances.find(
                              (effect) =>
                                  effect.id === context.ref.effectId &&
                                  effect.definition === content,
                          );
                          return current === undefined ? [] : value(current, query);
                      }
                    : value(context.self, {
                          unit: context.unit,
                          battlefield: battlefieldView(state),
                      }),
            }),
        );
    content = definition(id, initial, {
        ...callbacks,
        onEnable(state, context) {
            state = publish(state, context);
            return callbacks.onEnable ? callbacks.onEnable(state, context) : state;
        },
        onDisable(state, context) {
            state = transitionUnit(state, context.ref.unitId, (unit) =>
                remove(unit, key(context.ref)),
            );
            return callbacks.onDisable ? callbacks.onDisable(state, context) : state;
        },
    });
    return content;
}

export function refreshContribution(state, ref, content, { set, value, group }) {
    const current = get(state, ref);
    if (current?.status !== "ACTIVE") return state;
    return transitionUnit(state, ref.unitId, (unit) =>
        set(unit, {
            id: `${ref.unitId}:${ref.effectId}`,
            ...(group === undefined
                ? {}
                : { group: typeof group === "function" ? group(current) : group }),
            value: value(current, { unit, battlefield: battlefieldView(state) }),
        }),
    );
}
