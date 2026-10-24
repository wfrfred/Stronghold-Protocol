import assert from "node:assert/strict";
import { test } from "node:test";
import * as field from "../../dist/core/tactical/battlefield/state.js";
import { view } from "../../dist/core/tactical/battlefield/view.js";
import {
    createBattleState, getUnit, registerUnit, removeUnit, setBattlefield, updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { ref as effectRef } from "../../dist/core/tactical/unit/effect/effect.js";
import { dependents } from "../../dist/core/tactical/unit/effect/dependency.js";
import { initialize, fixtureBattle } from "../helpers/unit.js";

const unit = (id, definition = {}) => initialize({
    id, position: [id, 0], definition: { id: `dependency-host-${id}`, ...definition },
});

function scoped(host, scopes) {
    return {
        id: host.effects.nextId, host: { id: host.id },
        definition: { id: "prepared", initialize: () => ({}) },
        data: {}, source: null, scopes, enabled: true, status: "ACTIVE",
    };
}

function fixture(...units) {
    let battle = fixtureBattle();
    for (const unit of units) battle = registerUnit(battle, unit);
    return battle;
}

test("Battle initializes dependency state from prepared Unit effects without a Field index", () => {
    const owner = unit(1);
    const lifetime = { type: "UNIT", ref: { id: 2 } };
    const instance = scoped(owner, [lifetime]);
    let prepared = fixtureBattle().battlefield;
    prepared = field.addUnit(prepared, { ...owner, effects: owner.effects.add(instance) });
    prepared = field.addUnit(prepared, unit(2));
    const battle = createBattleState(prepared);
    assert.deepEqual(dependents(battle.effect.dependency, lifetime), [effectRef(instance)]);
    assert.equal("effectLifetimes" in prepared, false);
    assert.equal("effectLifetimes" in view(prepared), false);
    assert.equal("effect" in prepared, false);
});

test("registering and removing a prepared host updates only the runtime dependency state", () => {
    let battle = fixture(unit(2));
    const owner = unit(1);
    const lifetime = { type: "UNIT", ref: { id: 2 } };
    const instance = scoped(owner, [lifetime]);
    const previous = battle;
    battle = registerUnit(battle, { ...owner, effects: owner.effects.add(instance) });
    assert.deepEqual(dependents(previous.effect.dependency, lifetime), []);
    assert.deepEqual(dependents(battle.effect.dependency, lifetime), [effectRef(instance)]);
    const captured = battle.effect.dependency;
    battle = removeUnit(battle, owner.id, "SCRIPT");
    assert.deepEqual(dependents(battle.effect.dependency, lifetime), []);
    assert.deepEqual(dependents(captured, lifetime), [effectRef(instance)]);
});

test("dependency writes precede install callbacks and support nested dependent creation", () => {
    let battle = fixture(unit(1), unit(2), unit(3));
    const lifetime = { type: "UNIT", ref: { id: 2 } };
    let nested;
    const result = effects.install(battle, { id: 1 }, {
        id: "parent", initialize: () => ({}),
        onInstall(current, context) {
            assert.deepEqual(dependents(current.effect.dependency, lifetime), [context.ref]);
            const child = effects.install(current, { id: 3 }, {
                id: "child", initialize: () => ({}),
            }, { scopes: [{ type: "EFFECT", ref: context.ref }] });
            nested = child.value;
            return child.state;
        },
    }, { scopes: [lifetime] });
    battle = result.state;
    const parent = { type: "EFFECT", ref: result.value };
    assert.deepEqual(dependents(battle.effect.dependency, parent), [nested]);
    const captured = dependents(battle.effect.dependency, parent);
    battle = leave(battle, 2, "SCRIPT");
    assert.equal(effects.get(battle, result.value), undefined);
    assert.equal(effects.get(battle, nested), undefined);
    assert.deepEqual(dependents(battle.effect.dependency, parent), []);
    assert.deepEqual(captured, [nested]);
});

test("ENDING removes outgoing dependencies before content cleanup callbacks run", () => {
    let battle = fixture(unit(1), unit(2));
    const lifetime = { type: "UNIT", ref: { id: 2 } };
    let observed = false;
    const parent = effects.install(battle, { id: 1 }, {
        id: "ending", initialize: () => ({}),
        onDisable(current) {
            observed = true;
            assert.deepEqual(dependents(current.effect.dependency, lifetime), []);
            return current;
        },
    }, { scopes: [lifetime] });
    battle = effects.end(parent.state, parent.value);
    assert.equal(observed, true);
    assert.deepEqual(dependents(battle.effect.dependency, lifetime), []);
});

test("publishing an arbitrary Field version reconciles effects before support callbacks", () => {
    const lifetime = { type: "UNIT", ref: { id: 2 } };
    let notified = false;
    const provider = unit(0, {
        occupancy: {},
        tileBinding: {
            heightType: null, buildableType: "ALL", advancedBuildableMask: null,
            onSupportLost(current, _self, loss) {
                notified = true;
                assert.equal(loss.occupant.id, 1);
                assert.equal(dependents(current.effect.dependency, lifetime).length, 1);
                return effects.update(current, dependents(current.effect.dependency, lifetime)[0], () => ({ changed: true }));
            },
        },
    });
    const occupant = unit(1, { occupancy: {} });
    const registered = (self, slot) => ({
        ...self, occupancy: { registration: { tile: [0, 0], slot } },
    });
    let battle = fixture(registered(provider, "SUPPORT"), registered(occupant, "OCCUPANT"), unit(2));
    const current = getUnit(battle, 1);
    const instance = scoped(current, [lifetime]);
    const next = field.replaceUnit(battle.battlefield, {
        ...current,
        effects: current.effects.add(instance),
        occupancy: { registration: { tile: [0, 1], slot: "OCCUPANT" } },
    });
    battle = setBattlefield(battle, next);
    assert.equal(notified, true);
    assert.deepEqual(effects.get(battle, effectRef(instance)).data, { changed: true });
    assert.deepEqual(dependents(battle.effect.dependency, lifetime), [effectRef(instance)]);
});

test("ordinary Unit updates preserve the dependency state and its retained buckets", () => {
    const lifetime = { type: "UNIT", ref: { id: 2 } };
    let battle = fixture(unit(1), unit(2));
    battle = effects.install(battle, { id: 1 }, {
        id: "retained", initialize: () => ({}),
    }, { scopes: [lifetime] }).state;
    const previous = battle.effect;
    const bucket = dependents(previous.dependency, lifetime);
    battle = updateUnit(battle, { ...getUnit(battle, 1), position: [5, 0] });
    assert.equal(battle.effect, previous);
    assert.equal(dependents(battle.effect.dependency, lifetime), bucket);
});

test("a dependent ending callback can mutate another bucket without losing its update", () => {
    let battle = fixture(unit(1), unit(2), unit(3), unit(4));
    const first = { type: "UNIT", ref: { id: 1 } };
    const second = { type: "UNIT", ref: { id: 2 } };
    let replacement;
    battle = effects.install(battle, { id: 3 }, {
        id: "nested cleanup", initialize: () => ({}),
        onEnd(current) {
            const installed = effects.install(current, { id: 4 }, {
                id: "replacement", initialize: () => ({}),
            }, { scopes: [second] });
            replacement = installed.value;
            return installed.state;
        },
    }, { scopes: [first] }).state;
    battle = leave(battle, 1, "SCRIPT");
    assert.deepEqual(dependents(battle.effect.dependency, first), []);
    assert.deepEqual(dependents(battle.effect.dependency, second), [replacement]);
    assert.equal(effects.get(battle, replacement).status, "ACTIVE");
});
