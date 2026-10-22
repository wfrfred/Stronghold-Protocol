import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { select } from "../../dist/core/tactical/battle/targeting/select.js";
import { resolveAttack } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { selectStates as selectCapabilityStates } from "../../dist/core/tactical/unit/snapshot.js";
import { initialize as initializeUnit, placement } from "./unit.js";
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
            targetable: { restrictions: [] },
            vitality: { maxHp: 100, defense: 0, resistance: 0 },
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
        getUnit(state, context.ref.host.id)?.effects.values().toArray().find(
            (effect) => effect.id === context.ref.id,
        );
    const save = (state, context, transform) => effects.update(state, context.ref, transform);
    const refresh = (state, context) => {
        let self = selfOf(state, context);
        if (self?.status !== "ACTIVE") return state;
        const host = getUnit(state, context.ref.host.id);
        const selectedResult = select(state, {
            source: unitRef(host),
            purposes: ["EFFECT"],
            filter: (_battle, request, target) =>
                target.id !== request.source.id && accepts(target, host),
            selector: (battle, _request, candidates) => ({ state: battle, value: candidates.map(unitRef) }),
        });
        state = selectedResult.state;
        const selected = selectedResult.value.map(target => target.id);
        for (const binding of self.data.bindings) {
            if (selected.includes(binding.unitId)) continue;
            state = save(state, context, (current) => ({
                ...current,
                bindings: current.bindings.filter((item) => item !== binding),
            }));
            for (const ref of binding.refs)
                state = effects.end(state, ref, "AURA_LEFT");
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
                    unit: getUnit(state, context.ref.host.id),
                    self: selfOf(state, context),
                },
                unitId,
            );
            const installed = effects.install(
                state,
                unitRef(getUnit(state, unitId)),
                receiver,
                {
                    source: context.ref.host.id,
                    scopes: bindLifetime ? [{ type: "EFFECT", ref: context.ref }] : [],
                    ...(value === undefined ? {} : { data: value }),
                },
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
                state = effects.setEnabled(state, ref, false);
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
                        state = effects.setEnabled(state, ref, true);
                }
                return state;
            },
            onDisable(state, context) {
                if (context.self.status === "ENDING") return state;
                for (const binding of context.self.data.bindings) {
                    for (const ref of binding.refs)
                        state = effects.setEnabled(state, ref, false);
                }
                return state;
            },
        },
    );
}

export function seededPlacement(effect, unit = auraUnit(0), scopes = []) {
    const installed = effects.install(effectFixtureWork(unit), unitRef(unit), effect, {
        source: unit.id,
        scopes,
    });
    const seeded = getUnit(installed.state, unit.id);
    return placement({
        definition: seeded.definition,
        position: seeded.position,
        effects: seeded.effects,
        states: selectCapabilityStates(seeded),
    });
}

export function snapshotAttack(snapshot, unitId) {
    const battle = { ...effectFixtureWork(...snapshot.units), tick: snapshot.tickIndex };
    const unit = getUnit(battle, unitId);
    return unit === undefined ? undefined : resolveAttack(battle, unitRef(unit));
}
