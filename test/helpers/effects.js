import { fixtureBattlefield } from "./battlefield.js";
import {
    createBattleState,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/execution/context.js";
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

export function installFixtureEffect(unit, definition, input = {}, tick = 0) {
    const state = effectFixtureWork(unit);
    effects.apply({ ...state, tick }, unit, definition, input);
    return getUnit(state, unit.id);
}

export const definition = (id, initial = {}, callbacks = {}) => ({
    id,
    initialize: () => initial,
    ...callbacks,
});

export function install(
    state,
    definition,
    unitId = state.battlefield.snapshot("draft").unitIds[0],
    input = {},
) {
    return effects.apply(state, getUnit(state, unitId), definition, input);
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
            onEnable(context) {
                transitionUnit(context.battle, context.ref.unitId, (current) =>
                    set(current, {
                        id: `${context.ref.unitId}:${context.ref.effectId}`,
                        value: [modifier({ finalAddition: context.self.state.amount })],
                    }),
                );
                callbacks.onEnable?.(context);
            },
            onDisable(context) {
                transitionUnit(context.battle, context.ref.unitId, (current) =>
                    remove(current, `${context.ref.unitId}:${context.ref.effectId}`),
                );
                callbacks.onDisable?.(context);
            },
        },
    );
}

export function refreshAttack(state, ref) {
    const instance = get(state, ref);
    if (instance.status !== "ACTIVE") return;
    transitionUnit(state, ref.unitId, (current) =>
        setAttackContribution(current, {
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
    const publish = (context) =>
        transitionUnit(context.battle, context.ref.unitId, (unit) =>
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
                          battlefield: context.battle.battlefield.snapshot("draft"),
                      }),
            }),
        );
    content = definition(id, initial, {
        ...callbacks,
        onEnable(context) {
            publish(context);
            callbacks.onEnable?.(context);
        },
        onDisable(context) {
            transitionUnit(context.battle, context.ref.unitId, (unit) =>
                remove(unit, key(context.ref)),
            );
            callbacks.onDisable?.(context);
        },
    });
    return content;
}

export function refreshContribution(battle, ref, content, { set, value, group }) {
    const current = get(battle, ref);
    if (current?.status !== "ACTIVE") return;
    transitionUnit(battle, ref.unitId, (unit) =>
        set(unit, {
            id: `${ref.unitId}:${ref.effectId}`,
            ...(group === undefined
                ? {}
                : { group: typeof group === "function" ? group(current) : group }),
            value: value(current, { unit, battlefield: battle.battlefield.snapshot("draft") }),
        }),
    );
}
