import { ref as effectRef } from "../../dist/core/tactical/unit/effect/effect.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { select } from "../../dist/core/tactical/battle/targeting/select.js";
import { resolveAttack } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { selectStates as selectCapabilityStates } from "../../dist/core/tactical/unit/snapshot.js";
import { initialize as initializeUnit, placement } from "./unit.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
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
    const selfOf = (state, self) => effects.get(state, effectRef(self));
    const save = (state, self, transform) => effects.update(state, effectRef(self), transform);
    const refresh = (state, initial) => {
        let self = selfOf(state, initial);
        if (self?.status !== "ACTIVE") return state;
        const host = getUnit(state, self.host.id);
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
            state = save(state, initial, (current) => ({
                ...current,
                bindings: current.bindings.filter((item) => item !== binding),
            }));
            for (const ref of binding.refs)
                state = effects.end(state, ref, "AURA_LEFT");
        }
        for (const unitId of selected) {
            self = selfOf(state, initial);
            if (self?.status !== "ACTIVE") break;
            if (self.data.bindings.some((binding) => binding.unitId === unitId)) continue;
            state = save(state, self, (current) => ({
                ...current,
                bindings: [...current.bindings, { unitId, refs: [] }],
            }));
            self = selfOf(state, initial);
            if (self?.status !== "ACTIVE") break;
            const value = initialState(state, self, unitId);
            const installed = effects.install(
                state,
                unitRef(getUnit(state, unitId)),
                receiver,
                {
                    source: self.host.id,
                    scopes: bindLifetime ? [{ type: "EFFECT", ref: effectRef(self) }] : [],
                    ...(value === undefined ? {} : { data: value }),
                },
            );
            state = installed.state;
            const ref = installed.value;
            self = selfOf(state, initial);
            if (ref === undefined || self === undefined || self.status === "ENDING") continue;
            state = save(state, self, (current) => ({
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
            onTick(state, self) {
                if (state.tick < self.data.nextRefreshTick) return state;
                state = save(state, self, (current) => ({
                    ...current,
                    nextRefreshTick: state.tick + refreshInterval,
                }));
                return refresh(state, self);
            },
            onEnable(state, self) {
                state = refresh(state, self);
                const current = selfOf(state, self);
                if (current?.status !== "ACTIVE") return state;
                for (const binding of current.data.bindings) {
                    for (const ref of binding.refs)
                        state = effects.setEnabled(state, ref, true);
                }
                return state;
            },
            onDisable(state, self) {
                if (self.status === "ENDING") return state;
                for (const binding of self.data.bindings) {
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
