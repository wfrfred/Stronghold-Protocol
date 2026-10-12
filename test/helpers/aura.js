import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import { selectTargets } from "../../dist/core/tactical/unit/targeting/select.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { selectCapabilityStates } from "../../dist/core/tactical/unit/capability/catalog.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { definition, attackBuff, effectFixtureWork } from "./effects.js";

export const effectProgram = (id, initialize = () => ({})) => ({ id, initialize });
export function auraUnit(id, position = [0, 0], extra = {}) {
    return initializeUnit({
        id,
        position,
        definition: {
            id: `aura-unit-${id}`,
            vitality: { maxHp: 100 },
            offense: { attack: 100 },
            ...extra,
        },
    });
}
export const attackEffect = (id, callbacks = {}) => attackBuff(id, 20, callbacks);

export function auraEffect(
    receiver,
    {
        id = "aura",
        accepts = () => true,
        bindLifetime = true,
        initialState = () => undefined,
        refreshInterval = 1,
        group,
    } = {},
) {
    const selfOf = (state, context) =>
        getUnit(state, context.ref.unitId)?.effects.values().find(
            (effect) => effect.id === context.ref.effectId,
        );
    const save = (state, context, update) => {
        const current = selfOf(state, context);
        return current === undefined
            ? state
            : effects.replaceEffect(state, context.ref, setData(current, update));
    };
    const refresh = (state, context) => {
        let self = selfOf(state, context);
        if (self?.status !== "ACTIVE") return state;
        const host = getUnit(state, context.ref.unitId);
        const selected = selectTargets(
            { battlefield: battlefieldView(state), host },
            {
                candidates: (query) => query.battlefield.unitIds,
                accepts: (query, target) =>
                    target.id !== query.host.id && accepts(target, query.host),
                compare: () => 0,
                limit: (query) => query.battlefield.unitIds.length,
            },
        ).map((target) => target.id);
        for (const binding of self.data.bindings) {
            if (selected.includes(binding.unitId)) continue;
            state = save(state, context, (current) => ({
                ...current,
                bindings: current.bindings.filter((item) => item !== binding),
            }));
            for (const ref of binding.refs)
                state = effects.end(state, ref, "AURA_LEFT", context.call);
        }
        for (const unitId of selected) {
            self = selfOf(state, context);
            if (self?.status !== "ACTIVE") break;
            if (self.data.bindings.some((binding) => binding.unitId === unitId)) continue;
            state = save(state, context, (current) => ({
                ...current,
                bindings: [...current.bindings, { unitId, refs: [] }],
            }));
            const value = initialState(
                {
                    ...context,
                    unit: getUnit(state, context.ref.unitId),
                    self: selfOf(state, context),
                },
                unitId,
            );
            const installed = effects.install(
                state,
                getUnit(state, unitId),
                receiver,
                {
                    source: context.ref.unitId,
                    scopes: bindLifetime ? [context.ref] : [],
                    ...(value === undefined ? {} : { data: value }),
                },
                context.call,
            );
            state = installed.state;
            const ref = installed.value;
            self = selfOf(state, context);
            if (ref === undefined || self === undefined || self.status === "ENDING") continue;
            state = save(state, context, (current) => ({
                ...current,
                bindings: current.bindings.map((binding) =>
                    binding.unitId === unitId ? { ...binding, refs: [ref] } : binding,
                ),
            }));
            if (self.status !== "ACTIVE")
                state = effects.setEnabled(state, ref, false, context.call);
        }
        return state;
    };
    return definition(
        id,
        { bindings: [], nextRefreshTick: 0 },
        {
            ...(group === undefined ? {} : { group }),
            onTick(state, context) {
                if (context.tick < context.self.data.nextRefreshTick) return state;
                state = save(state, context, (current) => ({
                    ...current,
                    nextRefreshTick: context.tick + refreshInterval,
                }));
                return refresh(state, context);
            },
            onEnable(state, context) {
                state = refresh(state, context);
                const self = selfOf(state, context);
                if (self?.status !== "ACTIVE") return state;
                for (const binding of self.data.bindings) {
                    for (const ref of binding.refs)
                        state = effects.setEnabled(state, ref, true, context.call);
                }
                return state;
            },
            onDisable(state, context) {
                if (context.self.status === "ENDING") return state;
                for (const binding of context.self.data.bindings) {
                    for (const ref of binding.refs)
                        state = effects.setEnabled(state, ref, false, context.call);
                }
                return state;
            },
        },
    );
}

export function seededPlacement(effect, unit = auraUnit(0), scopes = []) {
    const installed = effects.install(effectFixtureWork(unit), unit, effect, {
        source: unit.id,
        scopes,
    });
    const seeded = getUnit(installed.state, unit.id);
    return {
        definition: seeded.definition,
        position: seeded.position,
        effects: seeded.effects,
        states: selectCapabilityStates(seeded),
    };
}

export function snapshotAttack(snapshot, unitId) {
    return resolveAttackPower(unitId, {
        unitIds: snapshot.units.map((unit) => unit.id),
        getUnit: (id) => snapshot.units.find((unit) => unit.id === id),
        blockerOf: () => undefined,
        blockedBy: () => [],
    });
}
