import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { fixtureBattlefieldState as fixtureBattlefield } from "./battlefield.js";
import {
    createBattleState,
    battlefieldView,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
import {
    setAttackContribution,
    removeAttackContribution,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import {
    setMaxHpContribution,
    removeMaxHpContribution,
} from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/attribute.js";

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
    const installed = effects.install({ ...state, tick }, unitRef(unit), definition, initial);
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
    return effects.install(state, unitRef(getUnit(state, unitId)), definition, initial);
}

export function at(state, tick) {
    return { ...state, tick };
}

export function replaceEffectFixture(state, reference, self) {
    return transitionUnit(state, reference.host.id, unit => {
        const next = unit.effects.replace(reference, self);
        return next === unit.effects ? unit : { ...unit, effects: next };
    });
}

export function attackBuff(id = "attack-buff", amount = 20, callbacks = {}) {
    return contributionBuff(
        id,
        amount,
        (unit, entry) => ({ ...unit, offense: setAttackContribution(unit.offense, entry) }),
        (unit, entryId) => ({ ...unit, offense: removeAttackContribution(unit.offense, entryId) }),
        callbacks,
    );
}

export function maxHpBuff(id = "max-hp-buff", amount = 100, callbacks = {}) {
    return contributionBuff(
        id,
        amount,
        (unit, entry) => ({
            ...unit,
            vitality: setMaxHpContribution(unit.vitality, unit.definition.vitality, entry),
        }),
        (unit, entryId) => ({
            ...unit,
            vitality: removeMaxHpContribution(unit.vitality, unit.definition.vitality, entryId),
        }),
        callbacks,
    );
}

function contributionBuff(id, amount, set, remove, callbacks) {
    return definition(
        id,
        { amount },
        {
            ...callbacks,
            onEnable(state, context) {
                state = transitionUnit(state, context.ref.host.id, (unit) =>
                    set(unit, {
                        id: `${context.ref.host.id}:${context.ref.id}`,
                        value: [modifier({ finalAddition: context.self.data.amount })],
                    }),
                );
                return callbacks.onEnable ? callbacks.onEnable(state, context) : state;
            },
            onDisable(state, context) {
                state = transitionUnit(state, context.ref.host.id, (unit) =>
                    remove(unit, `${context.ref.host.id}:${context.ref.id}`),
                );
                return callbacks.onDisable ? callbacks.onDisable(state, context) : state;
            },
        },
    );
}

export function refreshAttack(state, ref) {
    const instance = get(state, ref);
    if (instance?.status !== "ACTIVE") return state;
    return transitionUnit(state, ref.host.id, (unit) => ({
        ...unit,
        offense: setAttackContribution(unit.offense, {
            id: `${ref.host.id}:${ref.id}`,
            value: [modifier({ finalAddition: instance.data.amount })],
        }),
    }));
}

export function contributionEffect(
    id,
    initial,
    { capability, set, remove, value, group, dynamic = false },
    callbacks = {},
) {
    let content;
    const key = (ref) => `${ref.host.id}:${ref.id}`;
    const publish = (state, context) =>
        transitionUnit(state, context.ref.host.id, (unit) => ({
            ...unit,
            [capability]: set(unit[capability], {
                id: key(context.ref),
                ...(group === undefined
                    ? {}
                    : { group: typeof group === "function" ? group(context.self) : group }),
                value: capability === "offense"
                    ? dynamic
                        ? (battle, host) => {
                              const current = get(battle, context.ref);
                              return current === undefined ? [] : value(current, battle, host);
                          }
                        : value(context.self, state, unit)
                    : dynamic
                    ? (query) => {
                          const current = query.unit.effects
                              .values()
                              .find(
                                  (effect) =>
                                      effect.id === context.ref.id &&
                                      effect.definition === content,
                              );
                          return current === undefined ? [] : value(current, query);
                      }
                    : value(context.self, {
                          unit: context.unit,
                          battlefield: battlefieldView(state),
                      }),
            }),
        }));
    content = definition(id, initial, {
        ...callbacks,
        onEnable(state, context) {
            state = publish(state, context);
            return callbacks.onEnable ? callbacks.onEnable(state, context) : state;
        },
        onDisable(state, context) {
            state = transitionUnit(state, context.ref.host.id, (unit) => ({
                ...unit,
                [capability]: remove(unit[capability], key(context.ref)),
            }));
            return callbacks.onDisable ? callbacks.onDisable(state, context) : state;
        },
    });
    return content;
}

export function refreshContribution(state, ref, content, { capability, set, value, group }) {
    const current = get(state, ref);
    if (current?.status !== "ACTIVE") return state;
    return transitionUnit(state, ref.host.id, (unit) => ({
        ...unit,
        [capability]: set(unit[capability], {
            id: `${ref.host.id}:${ref.id}`,
            ...(group === undefined
                ? {}
                : { group: typeof group === "function" ? group(current) : group }),
            value: capability === "offense"
                ? value(current, state, unit)
                : value(current, { unit, battlefield: battlefieldView(state) }),
        }),
    }));
}
