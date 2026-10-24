import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit, registerUnit } from "../../dist/core/tactical/battle/state.js";
import * as blocking from "../../dist/core/tactical/battle/blocking/operations.js";
import * as query from "../../dist/core/tactical/battle/blocking/query.js";
import * as blocker from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import * as presence from "../../dist/core/tactical/unit/capability/presence/operations.js";
import * as blockable from "../../dist/core/tactical/unit/capability/blocking/blockable.js";
import { fixture, holder, target, change, acquire, blockedIds, ownerId, capacity, hook } from "../helpers/blocking.js";

const onBlocker = (battle, id, key, entry) => change(battle, id, unit => ({
    ...unit, blocker: blocker.setHook(unit.blocker, key, entry),
}));
const onBlockable = (battle, id, key, entry) => change(battle, id, unit => ({
    ...unit, blockable: blockable.setHook(unit.blockable, key, entry),
}));

test("a failed acquire does not create transient relations or notifications", () => {
    let battle = fixture([holder(10, { capacity: 1 }), target(20, { volume: 2 })]);
    const notifications = [];
    for (const key of ["acquired", "released"]) battle = onBlocker(battle, 10, key, hook(key, state => {
        notifications.push(key);
        return state;
    }));
    battle = acquire(battle);
    assert.deepEqual(blockedIds(battle), []);
    assert.equal(ownerId(battle), undefined);
    assert.deepEqual(notifications, []);
});

test("both relation endpoints and indexes are coherent before the first acquired Hook", () => {
    let battle = fixture([holder(), holder(11), target()]);
    const observed = [];
    battle = onBlocker(battle, 10, "acquired", hook("inspect", (state, context) => {
        assert.equal(context.host.id, 10);
        assert.equal(context.relation.blocker.id, 10);
        assert.equal(context.relation.blocked.id, 20);
        assert.equal(ownerId(state), 10);
        assert.deepEqual(blockedIds(state), [20]);
        assert.equal(getUnit(state, 10).blocker.blocked[0], context.relation.blocked);
        assert.equal(query.usedCapacity(state, { id: 10 }), 1);
        observed.push("blocker");
        state = acquire(state, 11);
        assert.equal(ownerId(state), 10, "nested search must observe exclusive ownership");
        return state;
    }));
    battle = onBlockable(battle, 20, "acquired", hook("inspect", state => {
        observed.push("blockable");
        return state;
    }));
    battle = acquire(battle);
    assert.deepEqual(observed, ["blocker", "blockable"]);
    assert.deepEqual(blockedIds(battle, 11), []);
});

test("search fixes candidate identities but reads live capacity after each acquired Hook", () => {
    let battle = fixture([holder(), target(20), target(21), target(22)]);
    battle = onBlocker(battle, 10, "acquired", hook("expand", (state, { relation }) => {
        if (relation.blocked.id !== 20) return state;
        state = capacity(state, 10, 4);
        return registerUnit(state, target(19));
    }));
    battle = acquire(battle);
    assert.deepEqual(blockedIds(battle), [20, 21, 22]);
    assert.equal(ownerId(battle, 19), undefined, "a newly registered candidate waits for another search");
    battle = acquire(battle);
    assert.deepEqual(blockedIds(battle), [20, 21, 22, 19]);
});

test("later candidates are checked against live eligibility and live ownership", () => {
    let battle = fixture([holder(10, { capacity: 3 }), holder(11, { capacity: 3 }), target(20), target(21), target(22)]);
    battle = onBlocker(battle, 10, "acquired", hook("alter-candidates", (state, { relation }) => {
        if (relation.blocked.id !== 20) return state;
        state = change(state, 21, unit => ({
            ...unit, blockable: blockable.setRule(unit.blockable, { id: "disabled", allows: () => false }),
        }));
        return acquire(state, 11);
    }));
    battle = acquire(battle);
    assert.deepEqual(blockedIds(battle), [20]);
    assert.equal(ownerId(battle, 21), undefined);
    assert.equal(ownerId(battle, 22), 11);
});

test("a capacity reduction in an acquired Hook changes subsequent attempts immediately", () => {
    let battle = fixture([holder(10, { capacity: 3 }), target(20), target(21), target(22)]);
    battle = onBlocker(battle, 10, "acquired", hook("shrink", (state, { relation }) => (
        relation.blocked.id === 20 ? capacity(state, 10, 1) : state
    )));
    battle = acquire(battle);
    assert.deepEqual(blockedIds(battle), [20]);
});

test("advance fixes the Blocker list before Hooks register additional blockers", () => {
    let battle = fixture([holder(), target(), target(30, { position: [7.25, 1] })]);
    battle = onBlocker(battle, 10, "acquired", hook("spawn-blocker", state => registerUnit(
        state, holder(11, { position: [7, 1] }),
    )));
    battle = blocking.advance(battle);
    assert.equal(ownerId(battle), 10);
    assert.equal(ownerId(battle, 30), undefined);
    battle = blocking.advance({ ...battle, tick: battle.tick + 1 });
    assert.equal(ownerId(battle, 30), 11);
});

test("release synchronously notifies both sides and does not search again", () => {
    let battle = fixture([holder(), target()]);
    const observed = [];
    battle = onBlocker(battle, 10, "released", hook("first", (state, context) => {
        observed.push([context.host.id, context.relation.blocked.id]);
        assert.equal(ownerId(state), undefined);
        assert.deepEqual(blockedIds(state), []);
        return state;
    }));
    battle = onBlockable(battle, 20, "released", hook("second", (state, context) => {
        observed.push([context.host.id, context.relation.blocker.id]);
        return state;
    }));
    battle = blocking.release(acquire(battle), { id: 20 });
    assert.deepEqual(observed, [[10, 20], [20, 10]]);
    assert.equal(ownerId(battle), undefined);
    assert.equal(blocking.release(battle, { id: 20 }), battle);
});

test("tail release notification can restore capacity before the next relation is removed", () => {
    let battle = fixture([holder(10, { capacity: 3 }), target(20), target(21), target(22)]);
    const removed = [];
    battle = onBlocker(battle, 10, "released", hook("restore", (state, { relation }) => {
        removed.push(relation.blocked.id);
        return relation.blocked.id === 22 ? capacity(state, 10, 2) : state;
    }));
    battle = capacity(acquire(battle), 10, 1);
    assert.deepEqual(removed, [22]);
    assert.deepEqual(blockedIds(battle), [20, 21]);
    assert.equal(query.usedCapacity(battle, { id: 10 }), 2);
});

test("a nested unrelated update completes capacity maintenance before its caller restores capacity", () => {
    let battle = fixture([holder(10, { capacity: 3 }), target(20), target(21), target(22), target(30, { position: [10, 1] })]);
    const removed = [];
    battle = onBlocker(battle, 10, "released", hook("nested-update", (state, { relation }) => {
        removed.push(relation.blocked.id);
        if (relation.blocked.id !== 22) return state;
        state = change(state, 30, unit => ({ ...unit, position: [10.25, 1] }));
        assert.deepEqual(blockedIds(state), [20], "each nested update must complete required maintenance");
        return capacity(state, 10, 2);
    }));
    battle = capacity(acquire(battle), 10, 1);
    assert.deepEqual(removed, [22, 21]);
    assert.deepEqual(blockedIds(battle), [20]);
});

test("pure reverse-link maintenance does not trim the next relation before notifying this release", () => {
    let battle = fixture([holder(10, { capacity: 3 }), target(20), target(21), target(22)]);
    const snapshots = [];
    battle = onBlocker(battle, 10, "released", hook("observe-prefix", (state, { relation }) => {
        snapshots.push([relation.blocked.id, blockedIds(state)]);
        return state;
    }));
    battle = capacity(acquire(battle), 10, 1);
    assert.deepEqual(snapshots, [[22, [20, 21]], [21, [20]]]);
    assert.deepEqual(blockedIds(battle), [20]);
});

test("a nested release stops the old relation's acquired Hooks without leaving contributions", () => {
    let battle = fixture([holder(), target()]);
    const order = [];
    let acquiredRelation;
    battle = onBlocker(battle, 10, "acquired", hook("release-now", (state, { relation }) => {
        acquiredRelation = relation;
        order.push("blocker acquired");
        return blocking.release(state, { id: 20 });
    }));
    battle = onBlocker(battle, 10, "acquired", hook("later", state => {
        order.push("later blocker acquired");
        return state;
    }));
    battle = onBlocker(battle, 10, "released", hook("released", (state, { relation }) => {
        order.push("blocker released");
        assert.equal(relation.blocked, acquiredRelation.blocked);
        return state;
    }));
    battle = onBlockable(battle, 20, "released", hook("released", (state, { relation }) => {
        order.push("blockable released");
        assert.equal(relation.blocked, acquiredRelation.blocked);
        return change(state, 20, unit => ({
            ...unit, blockable: blockable.removeVolumeContribution(unit.blockable, "relation-volume"),
        }));
    }));
    battle = onBlockable(battle, 20, "acquired", hook("install-contribution", state => {
        order.push("blockable acquired");
        return change(state, 20, unit => ({
            ...unit, blockable: blockable.setVolumeContribution(unit.blockable, { id: "relation-volume", value: 1 }),
        }));
    }));
    battle = acquire(battle);
    assert.deepEqual(order, ["blocker acquired", "blocker released", "blockable released"]);
    assert.equal(ownerId(battle), undefined);
    assert.deepEqual(getUnit(battle, 20).blockable.volume, []);
    assert.deepEqual(battle.events.map(({ type }) => type), ["BLOCKING_ACQUIRED", "BLOCKING_RELEASED"]);
});

test("blockable acquired Hooks also stop when their relation is released", () => {
    let battle = fixture([holder(), target()]);
    const calls = [];
    battle = onBlockable(battle, 20, "acquired", hook("release", state => {
        calls.push("blockable acquired");
        return blocking.release(state, { id: 20 });
    }));
    battle = onBlockable(battle, 20, "acquired", hook("later", state => {
        calls.push("later blockable acquired");
        return state;
    }));
    battle = acquire(battle);
    assert.deepEqual(calls, ["blockable acquired"]);
    assert.equal(ownerId(battle), undefined);
});

test("a same-pair reacquire does not resume the old relation's acquired Hooks", () => {
    let battle = fixture([holder(), target()]);
    const calls = [];
    let previous;
    battle = onBlocker(battle, 10, "acquired", hook("replace", (state, { relation }) => {
        calls.push(["blocker first", relation.blocked]);
        if (previous !== undefined) return state;
        previous = relation;
        return acquire(blocking.release(state, { id: 20 }));
    }));
    battle = onBlocker(battle, 10, "acquired", hook("later", (state, { relation }) => {
        calls.push(["blocker later", relation.blocked]);
        return state;
    }));
    battle = onBlockable(battle, 20, "acquired", hook("observe", (state, { relation }) => {
        calls.push(["blockable", relation.blocked]);
        return state;
    }));
    battle = acquire(battle);
    const current = getUnit(battle, 10).blocker.blocked[0];
    assert.notEqual(current, previous.blocked);
    assert.deepEqual(calls, [
        ["blocker first", previous.blocked],
        ["blocker first", current],
        ["blocker later", current],
        ["blockable", current],
    ]);
    assert.equal(ownerId(battle), 10);
    assert.deepEqual(battle.events.map(({ type }) => type), ["BLOCKING_ACQUIRED", "BLOCKING_RELEASED", "BLOCKING_ACQUIRED"]);
});

for (const key of ["acquired", "released"]) test(`${key} fixes both sides' Hook IDs and reads current replacements and accepts`, () => {
    let battle = fixture([holder(), target()]);
    const calls = [];
    const allows = state => (ownerId(state) === 10) === (key === "acquired");
    battle = onBlocker(battle, 10, key, hook("a", state => {
        calls.push("blocker a");
        state = onBlocker(state, 10, key, hook("b", latest => {
            calls.push("new blocker b");
            return latest;
        }, allows));
        state = onBlocker(state, 10, key, hook("c", latest => {
            calls.push("new blocker c");
            return latest;
        }));
        state = onBlockable(state, 20, key, hook("b", latest => {
            calls.push("new blockable b");
            return latest;
        }, allows));
        return onBlockable(state, 20, key, hook("c", latest => {
            calls.push("new blockable c");
            return latest;
        }));
    }));
    battle = onBlocker(battle, 10, key, hook("b", state => {
        calls.push("old blocker b");
        return state;
    }, () => false));
    battle = onBlockable(battle, 20, key, hook("b", state => {
        calls.push("old blockable b");
        return state;
    }, () => false));
    battle = acquire(battle);
    if (key === "released") battle = blocking.release(battle, { id: 20 });
    assert.deepEqual(calls, ["blocker a", "new blocker b", "new blockable b"]);
});

test("old captured Ref entries never release a same-pair relationship reestablished by a Hook", () => {
    let battle = fixture([holder(10, { capacity: 2 }), target(20), target(21)]);
    let reentered = false;
    battle = onBlocker(battle, 10, "released", hook("replace-relations", (state, { relation }) => {
        if (reentered || relation.blocked.id !== 20) return state;
        reentered = true;
        state = blocking.release(state, { id: 21 });
        return acquire(state);
    }));
    battle = acquire(battle);
    const old = blocking.capture(battle, { id: 10 });
    assert.equal(old.length, 2);
    battle = blocking.releaseCaptured(battle, old);
    assert.deepEqual(blockedIds(battle), [20, 21]);
    const current = getUnit(battle, 10).blocker.blocked;
    assert.notEqual(current[0], old[0].blocked);
    assert.notEqual(current[1], old[1].blocked);
    assert.equal(blocking.releaseCaptured(battle, old), battle);
});

test("a fresh same-owner Ref in an ordinary update does not notify or rebuild the relationship", () => {
    let battle = fixture([holder(), target()]);
    const calls = [];
    for (const key of ["acquired", "released"]) battle = onBlocker(battle, 10, key, hook(key, state => {
        calls.push(key);
        return state;
    }));
    battle = acquire(battle);
    const previous = getUnit(battle, 10).blocker.blocked;
    battle = change(battle, 20, unit => ({ ...unit, blockable: { ...unit.blockable, blocker: { id: 10 } } }));
    assert.equal(getUnit(battle, 10).blocker.blocked, previous);
    assert.deepEqual(calls, ["acquired"]);
});

test("an initially occupied candidate can be acquired after an earlier Hook releases its old owner", () => {
    let battle = fixture([
        holder(10, { capacity: 2 }), holder(11, { position: [3, 1] }),
        target(20), target(21, { position: [2.8, 1] }),
    ]);
    battle = acquire(battle, 11);
    assert.equal(ownerId(battle, 21), 11);
    battle = onBlocker(battle, 10, "acquired", hook("free-later-candidate", (state, { relation }) => (
        relation.blocked.id === 20 ? blocking.release(state, { id: 21 }) : state
    )));
    battle = acquire(battle);
    assert.deepEqual(blockedIds(battle), [20, 21]);
    assert.deepEqual(blockedIds(battle, 11), []);
});

test("a Unit can independently be blocked and block other Units", () => {
    let battle = fixture([
        holder(),
        target(20, { definition: { blocker: { capacity: 1, geometry: { radius: 1 } } } }),
        target(30, { position: [2.5, 1], side: "ALLY" }),
    ]);
    battle = acquire(acquire(battle), 20);
    assert.equal(ownerId(battle, 20), 10);
    assert.equal(ownerId(battle, 30), 20);
    assert.deepEqual(blockedIds(battle, 10), [20]);
    assert.deepEqual(blockedIds(battle, 20), [30]);
    battle = capacity(battle, 10, 0);
    assert.equal(ownerId(battle, 20), undefined);
    assert.equal(ownerId(battle, 30), 20);
    battle = capacity(battle, 10, 1);
    battle = acquire(battle);
    battle = capacity(battle, 20, 0);
    assert.equal(ownerId(battle, 20), 10);
    assert.equal(ownerId(battle, 30), undefined);
    assert.deepEqual(blockedIds(battle, 20), []);
});


test("explicit spatial changes publish the new position before releasing only the captured old relationships", () => {
    let battle = fixture([holder(10, { capacity: 2 }), target(20), target(21)]);
    let reentered = false;
    battle = onBlocker(battle, 10, "released", hook("reestablish-after-position-change", (state, { relation }) => {
        assert.deepEqual(getUnit(state, 10).position, [2.125, 1]);
        if (reentered || relation.blocked.id !== 20) return state;
        reentered = true;
        state = blocking.release(state, { id: 21 });
        return acquire(state);
    }));
    battle = acquire(battle);
    const old = getUnit(battle, 10).blocker.blocked;
    const previous = battle;
    battle = presence.appear(battle, { id: 10 }, [2.125, 1]);
    assert.deepEqual(blockedIds(battle), [20, 21]);
    assert.notEqual(getUnit(battle, 10).blocker.blocked[0], old[0]);
    assert.notEqual(getUnit(battle, 10).blocker.blocked[1], old[1]);
    assert.deepEqual(getUnit(previous, 10).position, [2, 1]);
});
