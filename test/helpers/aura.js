import { selectTargets } from "../../dist/core/tactical/unit/targeting/select.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { selectCapabilityStates } from "../../dist/core/tactical/unit/capability/catalog.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
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
    const refresh = (context) => {
        if (context.self.status !== "ACTIVE") return;
        const selected = selectTargets(
            { battlefield: battlefieldView(context.battle), host: context.unit },
            {
                candidates: (query) => query.battlefield.unitIds,
                accepts: (query, target) =>
                    target.id !== query.host.id && accepts(target, query.host),
                compare: () => 0,
                limit: (query) => query.battlefield.unitIds.length,
            },
        ).map((target) => target.id);
        for (const binding of context.self.state.bindings) {
            if (selected.includes(binding.unitId)) continue;
            context.setState((state) => ({
                ...state,
                bindings: state.bindings.filter((current) => current !== binding),
            }));
            for (const ref of binding.refs) effects.end(context.battle, ref, "AURA_LEFT");
        }
        for (const unitId of selected) {
            if (context.self.status !== "ACTIVE") break;
            if (context.self.state.bindings.some((binding) => binding.unitId === unitId)) continue;
            context.setState((state) => ({
                ...state,
                bindings: [...state.bindings, { unitId, refs: [] }],
            }));
            const value = initialState(context, unitId);
            const ref = effects.install(context.battle, getUnit(context.battle, unitId), receiver, {
                source: context.ref.unitId,
                scopes: bindLifetime ? [context.ref] : [],
                ...(value === undefined ? {} : { state: value }),
            });
            if (ref === undefined || context.self.status === "ENDING") continue;
            context.setState((state) => ({
                ...state,
                bindings: state.bindings.map((binding) =>
                    binding.unitId === unitId ? { ...binding, refs: [ref] } : binding,
                ),
            }));
            if (context.self.status !== "ACTIVE") effects.setEnabled(context.battle, ref, false);
        }
    };
    return definition(
        id,
        { bindings: [], nextRefreshTick: 0 },
        {
            ...(group === undefined ? {} : { group }),
            onTick(context) {
                if (context.tick < context.self.state.nextRefreshTick) return;
                context.setState((state) => ({
                    ...state,
                    nextRefreshTick: context.tick + refreshInterval,
                }));
                refresh(context);
            },
            onEnable(context) {
                refresh(context);
                if (context.self.status !== "ACTIVE") return;
                for (const binding of context.self.state.bindings) {
                    for (const ref of binding.refs) effects.setEnabled(context.battle, ref, true);
                }
            },
            onDisable(context) {
                if (context.self.status === "ENDING") return;
                for (const binding of context.self.state.bindings) {
                    for (const ref of binding.refs) effects.setEnabled(context.battle, ref, false);
                }
            },
        },
    );
}

export function seededPlacement(effect, unit = auraUnit(0), scopes = []) {
    const battle = effectFixtureWork(unit);
    effects.install(battle, unit, effect, { source: unit.id, scopes });
    const seeded = getUnit(battle, unit.id);
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
