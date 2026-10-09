import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { createBattlefieldRuntime } from "../../dist/core/tactical/battlefield/runtime.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { installNewEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import {
    effectDependents,
    effectTickCandidates,
} from "../../dist/core/tactical/unit/capability/effects/lifetime-index.js";
import {
    combatWorkChanges,
    createCombatWork,
    getCombatUnit,
    updateCombatUnit,
} from "../../dist/core/tactical/battle/execution/work.js";

function unit(id) {
    return initializeUnit({
        id,
        position: [0, 0],
        definition: { id: `index-unit-${id}`, vitality: { maxHp: 100 } },
    });
}

function fixture(count) {
    const resources = new CombatResources();
    const program = resources.registerEffect(createEffectProgram({
        id: "indexed-effect",
        initialize: () => ({}),
        ownState: state => state,
    }));
    const battlefield = createBattlefieldRuntime({ map: createBattlefieldMap(1, 1, [createTile({
        heightType: "LOWLAND", buildableType: "ALL", passableMask: "ALL",
        playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
    })]) });
    battlefield.apply(Array.from({ length: count }, (_, id) => ({ type: "REGISTER_UNIT", unit: unit(id) })));
    let work = createCombatWork(battlefield.view);

    for (let id = 0; id < count; id++) {
        const installed = installNewEffect(work, id, program.ref, {
            source: null,
            scopes: [{ type: "UNIT", unitId: 0 }, { type: "TICK", tick: 10 }],
        }, resources, 0);
        assert.equal(installed.result.type, "INSTALLED");
        work = installed.work;
    }
    battlefield.apply(combatWorkChanges(work));

    return battlefield;
}

test("effect lifetime index: successive domain Works reuse the committed baseline without reading every Unit", () => {
    const count = 128;
    const battlefield = fixture(count);
    let reads = 0;
    const view = {
        ...battlefield.view,
        getUnit: id => { reads++; return battlefield.view.getUnit(id); },
    };

    for (let phase = 0; phase < 12; phase++) {
        const work = createCombatWork(view);
        assert.equal(effectDependents(work, { type: "UNIT", unitId: 0 }).length, count);
        assert.equal(effectTickCandidates(work).length, count);
    }

    assert.equal(reads, 0);
});

test("effect lifetime index: overlay and commit update only changed Unit relations and retain the previous branch", () => {
    const battlefield = fixture(128);
    const baseline = battlefield.view.effectLifetimes;
    let reads = 0;
    const view = {
        ...battlefield.view,
        getUnit: id => { reads++; return battlefield.view.getUnit(id); },
    };
    const initial = createCombatWork(view);
    const current = getCombatUnit(initial, 7);
    const changed = {
        ...current,
        effects: {
            ...current.effects,
            instances: current.effects.instances.map(instance => ({
                ...instance,
                scopes: [{ type: "UNIT", unitId: 1 }, { type: "TICK", tick: 20 }],
            })),
        },
    };
    const work = updateCombatUnit(initial, changed);

    assert.equal(effectDependents(initial, { type: "UNIT", unitId: 0 }).length, 128);
    assert.equal(effectDependents(work, { type: "UNIT", unitId: 0 }).length, 127);
    assert.deepEqual(effectDependents(work, { type: "UNIT", unitId: 1 }), [{ type: "EFFECT", unitId: 7, effectId: 0 }]);
    assert.ok(reads <= 3, `one changed Unit read ${reads} baseline Units`);
    battlefield.apply(combatWorkChanges(work));
    const committed = createCombatWork(battlefield.view);
    assert.equal(effectDependents(committed, { type: "UNIT", unitId: 0 }).length, 127);
    assert.equal(effectDependents(committed, { type: "UNIT", unitId: 1 }).length, 1);
    assert.equal(baseline.dependents.get("UNIT:0").size, 128);
    assert.equal(effectTickCandidates(committed).length, 128);
});

test("effect lifetime index: finished instances leave entity and time indexes without rebuilding unrelated relations", () => {
    const battlefield = fixture(4);
    const initial = createCombatWork(battlefield.view);
    const current = getCombatUnit(initial, 2);
    const work = updateCombatUnit(initial, {
        ...current,
        effects: {
            ...current.effects,
            instances: current.effects.instances.map(instance => ({ ...instance, finished: true, participating: false })),
        },
    });

    assert.deepEqual(effectDependents(work, { type: "UNIT", unitId: 0 }).map(ref => ref.unitId), [0, 1, 3]);
    assert.deepEqual(effectTickCandidates(work).map(ref => ref.unitId), [0, 1, 3]);
    assert.equal(effectTickCandidates(initial).length, 4);
});

test("effect lifetime index: Battlefield forks and failed transactions retain their own committed projections", () => {
    const battlefield = fixture(4);
    const fork = battlefield.fork();
    const baseline = battlefield.view.effectLifetimes;
    assert.equal(fork.view.effectLifetimes, baseline);
    const moved = {
        ...fork.view.getUnit(2),
        effects: {
            ...fork.view.getUnit(2).effects,
            instances: fork.view.getUnit(2).effects.instances.map(instance => ({
                ...instance,
                scopes: [{ type: "UNIT", unitId: 1 }],
            })),
        },
    };
    fork.apply([{ type: "UPDATE_UNIT", unit: moved }]);
    assert.deepEqual(effectDependents(createCombatWork(fork.view), { type: "UNIT", unitId: 0 }).map(ref => ref.unitId), [0, 1, 3]);
    assert.equal(effectDependents(createCombatWork(battlefield.view), { type: "UNIT", unitId: 0 }).length, 4);
    assert.throws(() => battlefield.transact(current => {
        current.apply([{ type: "UPDATE_UNIT", unit: moved }]);
        assert.equal(effectDependents(createCombatWork(current.view), { type: "UNIT", unitId: 1 }).length, 1);
        throw new Error("abort projection");
    }), /abort projection/);
    assert.equal(battlefield.view.effectLifetimes, baseline);
    assert.equal(effectDependents(createCombatWork(battlefield.view), { type: "UNIT", unitId: 0 }).length, 4);
});
