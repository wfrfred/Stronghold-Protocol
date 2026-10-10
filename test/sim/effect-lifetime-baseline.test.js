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
    createBattleState,
    getUnit,
    updateUnit,
} from "../../dist/core/tactical/battle/execution/context.js";

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
    battlefield.advance(Array.from({ length: count }, (_, id) => ({ type: "REGISTER_UNIT", unit: unit(id) })));
    let work = createBattleState(battlefield);

    for (let id = 0; id < count; id++) {
        const installed = installNewEffect(work, id, program.ref, {
            source: null,
            scopes: [{ type: "UNIT", unitId: 0 }, { type: "TICK", tick: 10 }],
        }, resources, 0);
        assert.equal(installed.result.type, "INSTALLED");
        work = installed.work;
    }
    battlefield.apply();

    return battlefield;
}

test("effect lifetime index: successive domain states reuse the Battlefield projection", () => {
    const count = 128;
    const battlefield = fixture(count);
    const projection = battlefield.view.effectLifetimes;
    for (let phase = 0; phase < 12; phase++) {
        const state = createBattleState(battlefield);
        assert.equal(state.battlefield.view.effectLifetimes, projection);
        assert.equal(effectDependents(state, { type: "UNIT", unitId: 0 }).length, count);
        assert.equal(effectTickCandidates(state).length, count);
    }
});

test("effect lifetime index: draft transitions maintain changed Unit relations and retain published projections", () => {
    const battlefield = fixture(128);
    const baseline = battlefield.view.effectLifetimes;
    const initial = createBattleState(battlefield);
    const snapshot = battlefield.snapshot("state");
    const current = getUnit(initial, 7);
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
    const work = updateUnit(initial, changed);

    assert.equal(snapshot.effectLifetimes.dependents.get("UNIT:0").size, 128);
    assert.equal(effectDependents(work, { type: "UNIT", unitId: 0 }).length, 127);
    assert.deepEqual(effectDependents(work, { type: "UNIT", unitId: 1 }), [{ type: "EFFECT", unitId: 7, effectId: 0 }]);
    battlefield.apply();
    const committed = createBattleState(battlefield);
    assert.equal(effectDependents(committed, { type: "UNIT", unitId: 0 }).length, 127);
    assert.equal(effectDependents(committed, { type: "UNIT", unitId: 1 }).length, 1);
    assert.equal(baseline.dependents.get("UNIT:0").size, 128);
    assert.equal(effectTickCandidates(committed).length, 128);
});

test("effect lifetime index: finished instances leave entity and time indexes without rebuilding unrelated relations", () => {
    const battlefield = fixture(4);
    const initial = createBattleState(battlefield);
    const current = getUnit(initial, 2);
    const work = updateUnit(initial, {
        ...current,
        effects: {
            ...current.effects,
            instances: current.effects.instances.map(instance => ({ ...instance, finished: true, participating: false })),
        },
    });

    assert.deepEqual(effectDependents(work, { type: "UNIT", unitId: 0 }).map(ref => ref.unitId), [0, 1, 3]);
    assert.deepEqual(effectTickCandidates(work).map(ref => ref.unitId), [0, 1, 3]);
    assert.equal(battlefield.snapshot("state").getUnit(2).effects.instances[0].finished, false);
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
    fork.advance([{ type: "UPDATE_UNIT", unit: moved }]);
    assert.deepEqual(effectDependents(createBattleState(fork), { type: "UNIT", unitId: 0 }).map(ref => ref.unitId), [0, 1, 3]);
    assert.equal(effectDependents(createBattleState(battlefield), { type: "UNIT", unitId: 0 }).length, 4);
    assert.throws(() => battlefield.transact(current => {
        current.advance([{ type: "UPDATE_UNIT", unit: moved }]);
        assert.equal(effectDependents(createBattleState(current), { type: "UNIT", unitId: 1 }).length, 1);
        throw new Error("abort projection");
    }), /abort projection/);
    assert.equal(battlefield.view.effectLifetimes, baseline);
    assert.equal(effectDependents(createBattleState(battlefield), { type: "UNIT", unitId: 0 }).length, 4);
});
