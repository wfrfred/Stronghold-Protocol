import { closeLifetime } from "../../dist/core/tactical/battle/execution/lifetime.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import {
    battlefieldView,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { dependents } from "../../dist/core/tactical/battlefield/storage/effect-lifetimes.js";
import { definition, install, effectFixtureWork } from "../helpers/effects.js";
const unit = (id) => initialize({ id, position: [0, 0], definition: { id: `host-${id}` } });

test("scope index tracks remote dependencies and preserves captured indexes", () => {
    let battle = effectFixtureWork(unit(1), unit(2), unit(9));
    const content = definition("indexed");
    let parent;
    ({ state: battle, value: parent } = install(battle, content, 1));
    let child;
    ({ state: battle, value: child } = install(battle, content, 9, { scopes: [parent] }));
    let other;
    ({ state: battle, value: other } = install(battle, content, 2, { scopes: [parent] }));
    const captured = battlefieldView(battle);
    assert.deepEqual(dependents(battlefieldView(battle).effectLifetimes, parent), [other, child]);
    battle = effects.end(battle, other);
    assert.deepEqual(dependents(battlefieldView(battle).effectLifetimes, parent), [child]);
    assert.equal(captured.effectLifetimes.dependents.get("EFFECT:1:0").size, 2);
    const unrelated = battlefieldView(battle).effectLifetimes;
    battle = transitionUnit(battle, 2, (current) => ({ ...current, position: [1, 0] }));
    assert.equal(battlefieldView(battle).effectLifetimes, unrelated);
    battle = effects.end(battle, parent);
    assert.deepEqual(dependents(battlefieldView(battle).effectLifetimes, parent), []);
    assert.deepEqual(getUnit(battle, 9).effects.values(), []);
});

test("binding rejects scope cycles while sharing independent scopes", () => {
    let battle = effectFixtureWork(unit(1), unit(2));
    const content = definition("cycle");
    let first;
    ({ state: battle, value: first } = install(battle, content, 1));
    let second;
    ({ state: battle, value: second } = install(battle, content, 2, { scopes: [first] }));
    assert.throws(() => effects.bindLifetime(battle, first, second), /cycle/);
    const bound = effects.bindLifetime(battle, second, { type: "UNIT", unitId: 1 });
    battle = bound.state;
    assert.equal(bound.value, true);
    assert.deepEqual(
        dependents(battlefieldView(battle).effectLifetimes, { type: "UNIT", unitId: 1 }),
        [second],
    );
    battle = closeLifetime(battle, { type: "UNIT", unitId: 1 });
    assert.deepEqual(getUnit(battle, 1).effects.values(), []);
    assert.deepEqual(getUnit(battle, 2).effects.values(), []);
});
