import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { selectTargets } from '../../dist/core/tactical/unit/targeting/select.js';
import { attack } from '../../dist/core/tactical/unit/capability/offense/contributions.js';
import { resolveAttackPower } from '../../dist/core/tactical/unit/capability/offense/query.js';
import { create as modifier } from '../../dist/core/tactical/modifier/value.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { installNewEffect } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { effectFixtureWork } from './effects.js';

export const effectProgram = (id, initialize = () => ({})) => createEffectProgram({
    id, initialize,
});

export function auraUnit(id, position = [0, 0], extra = {}) {
    return initializeUnit({
        id, position,
        definition: { id: `aura-unit-${id}`, vitality: { maxHp: 100 }, offense: { attack: 100 }, ...extra },
    });
}

export function attackEffect(resources, id, facets = {}) {
    return resources.registerEffect(effectProgram(id, () => ({ addition: 20 })), {
        contributions: [attack(instance => [modifier({ finalAddition: instance.state.addition })])],
        ...facets,
    });
}

/** Ordinary aura content: membership persists even when its installed buff disappears. */
export function registerAura(resources, receiver, {
    id = 'aura', accepts = () => true, bindLifetime = true,
    initialState = () => undefined, competition, refreshInterval = 1,
} = {}) {
    let aura;
    const refreshTargets = context => {
        const host = context.battlefield.getUnit(context.ref.unitId);
        if (host === undefined || context.instance.finished || !context.instance.participating) return;
        const selected = selectTargets({ battlefield: context.battlefield, host }, {
            candidates: query => query.battlefield.unitIds,
            accepts: (query, target) => target.id !== query.host.id && accepts(target, query.host),
            compare: () => 0,
            limit: query => query.battlefield.unitIds.length,
        }).map(target => target.id);

        for (const binding of context.instance.state.bindings) {
            if (context.instance.finished) return;
            if (selected.includes(binding.unitId)) continue;
            context.effects.update(context.ref, aura.ref, state => ({
                ...state, bindings: state.bindings.filter(current => current.unitId !== binding.unitId),
            }));
            context.effects.finish(binding.refs, 'AURA_LEFT');
        }
        for (const unitId of selected) {
            if (context.instance.finished || !context.instance.participating) break;
            if (context.instance.state.bindings.some(binding => binding.unitId === unitId)) continue;
            // Reserve the entering member before installation invokes nested content callbacks.
            context.effects.update(context.ref, aura.ref, state => ({
                ...state, bindings: [...state.bindings, { unitId, refs: [] }],
            }));
            const value = initialState(context, unitId);
            const installed = context.effects.install(unitId, receiver.ref, {
                source: context.ref.unitId,
                scopes: bindLifetime ? [context.ref] : [],
                ...(value === undefined ? {} : { initialState: value }),
            });
            if (installed.type !== 'INSTALLED' || context.instance.finished) continue;
            context.effects.update(context.ref, aura.ref, state => ({
                ...state,
                bindings: state.bindings.map(binding => binding.unitId === unitId
                    ? { ...binding, refs: [installed.ref] } : binding),
            }));
            // Installation can synchronously stop the aura before its child is registered here.
            if (!context.instance.participating) {
                context.effects.setEnabled(installed.ref, false);
                break;
            }
        }
    };
    aura = resources.registerEffect(effectProgram(id, () => ({ bindings: [], nextRefreshTick: 0 })), {
        lifecycle: {
            ...(competition === undefined ? {} : { competition }),
            advance: context => {
                if (context.tick < context.instance.state.nextRefreshTick) return;
                context.effects.update(context.ref, aura.ref, state => ({
                    ...state, nextRefreshTick: context.tick + refreshInterval,
                }));
                refreshTargets(context);
            },
            enable: context => {
                refreshTargets(context);
                for (const binding of context.instance.state.bindings) {
                    if (context.instance.finished || !context.instance.participating) break;
                    for (const ref of binding.refs) {
                        if (context.instance.finished || !context.instance.participating) break;
                        context.effects.setEnabled(ref, true);
                    }
                }
            },
            disable: context => {
                if (context.instance.finished) return;
                for (const binding of context.instance.state.bindings) {
                    for (const ref of binding.refs) context.effects.setEnabled(ref, false);
                }
            },
        },
    });
    return aura;
}

export function seededPlacement(resources, effect, unit = auraUnit(0), scopes = []) {
    const state = effectFixtureWork(unit);
    const installed = installNewEffect(state, unit.id, effect.ref,
        { source: unit.id, scopes }, resources, 0);
    if (installed.type !== 'INSTALLED') throw new Error(`seed failed: ${installed.type}`);
    const seeded = getUnit(state, unit.id);
    return { definition: seeded.definition, position: seeded.position, states: { effects: seeded.effects } };
}

export function snapshotAttack(snapshot, unitId, resources) {
    return resolveAttackPower(unitId, {
        unitIds: snapshot.units.map(unit => unit.id),
        getUnit: id => snapshot.units.find(unit => unit.id === id),
        blockerOf: () => undefined, blockedBy: () => [],
    }, resources.computations);
}
