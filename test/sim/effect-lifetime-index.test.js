import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import {
    battlefieldView,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/execution/context.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { dependents } from "../../dist/core/tactical/battlefield/storage/effect-lifetimes.js";
import { definition, install, effectFixtureWork } from "../helpers/effects.js";
const unit = (id) => initializeUnit({ id, position: [0, 0], definition: { id: `host-${id}` } });

test("scope index tracks remote dependencies and preserves captured indexes", () => {
    const battle = effectFixtureWork(unit(1), unit(2), unit(9));
    const content = definition("indexed");
    const parent = install(battle, content, 1);
    const child = install(battle, content, 9, { scopes: [parent] });
    const other = install(battle, content, 2, { scopes: [parent] });
    const captured = battlefieldView(battle);
    assert.deepEqual(dependents(battlefieldView(battle).effectLifetimes, parent), [other, child]);
    effects.end(battle, other);
    assert.deepEqual(dependents(battlefieldView(battle).effectLifetimes, parent), [child]);
    assert.equal(captured.effectLifetimes.dependents.get("EFFECT:1:0").size, 2);
    const unrelated = battlefieldView(battle).effectLifetimes;
    transitionUnit(battle, 2, (current) => ({ ...current, position: [1, 0] }));
    assert.equal(battlefieldView(battle).effectLifetimes, unrelated);
    effects.end(battle, parent);
    assert.deepEqual(dependents(battlefieldView(battle).effectLifetimes, parent), []);
    assert.deepEqual(getUnit(battle, 9).effects.instances, []);
});

test("binding rejects scope cycles while sharing independent scopes", () => {
    const battle = effectFixtureWork(unit(1), unit(2));
    const content = definition("cycle");
    const first = install(battle, content, 1);
    const second = install(battle, content, 2, { scopes: [first] });
    assert.throws(() => effects.bind(battle, first, second), /cycle/);
    assert.equal(effects.bind(battle, second, { type: "UNIT", unitId: 1 }), true);
    assert.deepEqual(
        dependents(battlefieldView(battle).effectLifetimes, { type: "UNIT", unitId: 1 }),
        [second],
    );
    effects.endScope(battle, { type: "UNIT", unitId: 1 });
    assert.deepEqual(getUnit(battle, 1).effects.instances, []);
    assert.deepEqual(getUnit(battle, 2).effects.instances, []);
});
