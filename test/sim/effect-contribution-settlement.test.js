import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createEffectDefinition } from "../../dist/core/tactical/unit/capability/effects/definition.js";
import {
    finishEffects,
    installNewEffect,
    updateEffectState,
} from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { maxHp } from "../../dist/core/tactical/unit/capability/vitality/contributions.js";
import { resolveMaxHp } from "../../dist/core/tactical/unit/capability/vitality/query.js";
import { capacity } from "../../dist/core/tactical/unit/capability/blocking/contributions.js";
import { resolveBlockingCapacity } from "../../dist/core/tactical/unit/capability/blocking/capability.js";
import * as modifier from "../../dist/core/tactical/contribution/value.js";
import { effectFixtureWork } from "../helpers/effects.js";

const definition = (id, state = {}) => createEffectDefinition({ id, initialize: () => state });
const input = { source: null, scopes: [] };
const install = (state, unitId, effect, resources, scopes = []) =>
    installNewEffect(state, unitId, effect, { ...input, scopes }, resources, 0).ref;

test("finishEffects publishes every host's settled contributions before lifecycle callbacks", () => {
    const resources = new CombatResources();
    const notices = [];
    let refs;
    const inspect = (label, context) => {
        for (const ref of refs) {
            const unit = context.facts.getUnit(ref.unitId);
            assert.equal(context.facts.getEffect(ref).finished, true);
            assert.equal(unit.vitality.hp, 50);
            assert.equal(resolveMaxHp(ref.unitId, context.battlefield), 100);
            assert.deepEqual(unit.vitality.maxHp, []);
        }
        notices.push(`${label}:${context.ref.unitId}`);
    };
    const effect = resources.registerEffect(definition("host-max-hp"), {
        contributions: [maxHp(() => [modifier.create({ addition: 100 })])],
        lifecycle: {
            disable: (context) => inspect("disable", context),
            finish: (context) => inspect("finish", context),
        },
    });
    const hosts = [1, 2].map((id) => {
        const unit = initializeUnit({
            id,
            definition: { id: `host-${id}`, vitality: { maxHp: 100 } },
            position: [id, 0],
        });
        return { ...unit, vitality: { ...unit.vitality, hp: 50 } };
    });
    const state = effectFixtureWork(...hosts);
    const parent = install(state, 1, effect, resources);
    const child = install(state, 2, effect, resources, [parent]);
    refs = [parent, child];
    const previous = battlefieldView(state);

    finishEffects(state, [parent], resources, 1);

    assert.deepEqual(notices, ["disable:1", "disable:2", "finish:1", "finish:2"]);
    for (const id of [1, 2]) {
        assert.equal(previous.getUnit(id).vitality.hp, 100);
        assert.equal(resolveMaxHp(id, previous), 200);
        assert.equal(previous.getUnit(id).effects.instances[0].finished, false);
    }
});

test("one finish event keeps blocking when temporary contribution removals would release it", () => {
    const blocker = (id, position) => initializeUnit({
        id,
        position,
        definition: {
            id: `blocker-${id}`,
            allegiance: { side: "ALLY" },
            vitality: { maxHp: 100 },
            blocker: { capacity: 1, geometry: { radius: 1 } },
            status: { initialFlags: [] },
        },
    });
    const enemy = initializeUnit({
        id: 20,
        position: [1.25, 0],
        definition: {
            id: "enemy",
            allegiance: { side: "ENEMY" },
            vitality: { maxHp: 100 },
            spatial: { layer: "GROUND" },
            blockable: { weight: 1 },
        },
    });
    const state = effectFixtureWork(blocker(10, [1, 0]), enemy);
    const resources = new CombatResources();
    const positive = resources.registerEffect(definition("positive-capacity"), {
        contributions: [capacity(() => [modifier.create({ addition: 1 })])],
    });
    const negative = resources.registerEffect(definition("negative-capacity"), {
        contributions: [capacity(() => [modifier.create({ addition: -1 })])],
    });
    const roots = [install(state, 10, positive, resources), install(state, 10, negative, resources)];
    state.battlefield.advance([{ type: "REGISTER_UNIT", unit: blocker(11, [1.2, 0]) }]);
    assert.equal(battlefieldView(state).blockerOf(20), 10);

    finishEffects(state, roots, resources, 1);

    const view = battlefieldView(state);
    const unit = getUnit(state, 10);
    assert.equal(resolveBlockingCapacity(unit.definition.blocker, unit.blocker), 1);
    assert.equal(view.blockerOf(20), 10);
    assert.deepEqual(view.blockedBy(11), []);
});

test("a state update that enables a competitor installs its latest contribution", () => {
    const resources = new CombatResources();
    const observations = [];
    const candidate = resources.registerEffect(definition("candidate", { priority: 1, amount: 50 }), {
        contributions: [maxHp((instance) => [modifier.create({ addition: instance.state.amount })])],
        lifecycle: {
            competition: (instance) => ({ group: "rank", priority: instance.state.priority }),
            enable: (context) => observations.push([
                context.instance.state.amount,
                context.facts.getUnit(1).vitality.hp,
                resolveMaxHp(1, context.battlefield),
            ]),
        },
    });
    const leader = resources.registerEffect(definition("leader"), {
        lifecycle: { competition: () => ({ group: "rank", priority: 2 }) },
    });
    const host = initializeUnit({
        id: 1,
        position: [0, 0],
        definition: { id: "competitor-host", vitality: { maxHp: 100 } },
    });
    const state = effectFixtureWork({ ...host, vitality: { ...host.vitality, hp: 50 } });
    install(state, 1, leader, resources);
    const ref = install(state, 1, candidate, resources);
    assert.deepEqual(getUnit(state, 1).vitality.maxHp, []);

    updateEffectState(state, ref.unitId, ref.effectId, candidate,
        () => ({ priority: 3, amount: 200 }), resources, 1);

    assert.deepEqual(observations, [[200, 150, 300]]);
    assert.equal(getUnit(state, 1).vitality.maxHp.length, 1);
});
