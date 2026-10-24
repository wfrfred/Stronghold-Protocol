import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit, registerUnit, updateUnit, removeUnit } from "../../dist/core/tactical/battle/state.js";
import { replaceUnit } from "../../dist/core/tactical/battlefield/state.js";
import * as blocking from "../../dist/core/tactical/battle/blocking/operations.js";
import * as query from "../../dist/core/tactical/battle/blocking/query.js";
import * as blocker from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import * as blockable from "../../dist/core/tactical/unit/capability/blocking/blockable.js";
import { fixture, holder, target, change, acquire, blockedIds, ownerId, capacity } from "../helpers/blocking.js";

test("Field and Unit updates do not acquire blocking before an explicit search", () => {
    let battle = fixture([holder(), target(20, { position: [4, 1] })]);
    const original = battle;
    const next = { ...getUnit(battle, 20), position: [2.25, 1] };
    const field = replaceUnit(battle.battlefield, next);
    assert.equal(field.units.get(20).blockable.blocker, null);
    assert.deepEqual(field.units.get(10).blocker.blocked, []);
    battle = updateUnit(battle, next);
    assert.equal(ownerId(battle), undefined);
    assert.deepEqual(blockedIds(battle), []);
    battle = acquire(battle);
    assert.equal(ownerId(battle), 10);
    assert.equal(ownerId(original), undefined);
});

test("advance searches blockers in registration order; each search sorts distance then target ID", () => {
    let battle = fixture([
        holder(10, { position: [1, 1], capacity: 2 }),
        target(23, { position: [1.5, 1] }),
        holder(5, { position: [2, 1] }),
        target(22, { position: [1.5, 1] }),
        target(21, { position: [1.25, 1] }),
    ]);
    battle = blocking.advance(battle);
    assert.deepEqual(blockedIds(battle, 10), [21, 22]);
    assert.deepEqual(blockedIds(battle, 5), [23]);
});

test("blocking checks hostile sides and requires allegiance on both ends", () => {
    for (const [left, right, expected] of [
        ["ALLY", "NEUTRAL", false], ["ENEMY", "NEUTRAL", true],
        ["NEUTRAL", "ENEMY", true], [null, "ENEMY", false], ["ALLY", null, false],
    ]) {
        const without = (unit, side) => {
            if (side !== null) return unit;
            const { allegiance: ignoredDefinition, ...definition } = unit.definition;
            const { allegiance: ignoredState, ...remaining } = unit;
            return { ...remaining, definition };
        };
        const battle = acquire(fixture([
            without(holder(10, { side: left ?? "ALLY" }), left),
            without(target(20, { side: right ?? "ENEMY" }), right),
        ]));
        assert.equal(ownerId(battle), expected ? 10 : undefined, `${left} -> ${right}`);
    }
});

test("new blockers and restored eligibility wait for search; existing relations retain priority", () => {
    let battle = acquire(fixture([holder(), target()]));
    const previous = battle;
    battle = registerUnit(battle, holder(5, { position: [2.125, 1] }));
    battle = blocking.advance(battle);
    assert.equal(ownerId(battle), 10);
    battle = change(battle, 10, unit => ({
        ...unit, blocker: blocker.setRule(unit.blocker, { id: "disabled", allows: () => false }),
    }));
    assert.equal(ownerId(battle), undefined);
    assert.deepEqual(blockedIds(battle, 10), []);
    battle = change(battle, 10, unit => ({ ...unit, blocker: blocker.removeRule(unit.blocker, "disabled") }));
    assert.equal(ownerId(battle), undefined);
    battle = acquire(battle);
    assert.equal(ownerId(battle), 10);
    assert.equal(ownerId(previous), 10);
});

for (const [name, transform] of [
    ["HP reaches zero", unit => ({ ...unit, vitality: { ...unit.vitality, hp: 0 } })],
    ["LEAVING begins", unit => ({ ...unit, lifecycle: "LEAVING" })],
    ["spatial presence disappears", unit => ({ ...unit, spatialPresence: { present: false } })],
    ["allegiance ceases to be hostile", unit => ({ ...unit, allegiance: { side: "ENEMY" } })],
]) {
    test(`updateUnit immediately releases invalid relations when blocker ${name}`, () => {
        let battle = acquire(fixture([holder(), holder(11, { position: [3, 1] }), target()]));
        const before = battle;
        battle = change(battle, 10, transform);
        assert.equal(ownerId(battle), undefined);
        assert.deepEqual(blockedIds(battle), []);
        assert.equal(ownerId(before), 10);
        assert.equal(ownerId(acquire(battle, 11)), 11);
    });
}

test("removing either endpoint releases its associations without acquiring a replacement", () => {
    let battle = acquire(fixture([holder(), holder(11, { position: [3, 1] }), target()]));
    battle = removeUnit(battle, 10, "RETREAT");
    assert.equal(ownerId(battle), undefined);
    assert.deepEqual(blockedIds(battle, 11), []);
    battle = acquire(battle, 11);
    battle = removeUnit(battle, 20, "DEATH");
    assert.deepEqual(blockedIds(battle, 11), []);
});

test("capacity shrinking removes the ordered tail until the remaining prefix fits", () => {
    let battle = acquire(fixture([
        holder(10, { capacity: 3 }), target(20, { volume: 2 }), target(21), target(22),
    ]));
    assert.deepEqual(blockedIds(battle), [20, 21]);
    battle = capacity(battle, 10, 1);
    assert.deepEqual(blockedIds(battle), []);
    battle = capacity(battle, 10, 3);
    assert.deepEqual(blockedIds(battle), []);
    battle = acquire(battle);
    assert.deepEqual(blockedIds(battle), [20, 21]);
    battle = change(battle, 20, unit => ({
        ...unit, blockable: blockable.setVolumeContribution(unit.blockable, { id: "larger", value: 2 }),
    }));
    assert.deepEqual(blockedIds(battle), []);
    assert.equal(query.usedCapacity(battle, { id: 10 }), 0);
});

test("existing blocking is retained beyond acquisition distance and radius changes only affect search", () => {
    let battle = acquire(fixture([holder(), target()]));
    const stored = getUnit(battle, 10).blocker.blocked[0];
    battle = change(battle, 20, unit => ({ ...unit, position: [8, 1] }));
    battle = change(battle, 10, unit => ({ ...unit, blocker: { ...unit.blocker, geometry: { radius: 0 } } }));
    assert.equal(getUnit(battle, 10).blocker.blocked[0], stored);
    assert.equal(ownerId(battle), 10);
    battle = blocking.release(battle, { id: 20 });
    assert.equal(ownerId(acquire(battle)), undefined);
});

test("search uses inclusive radius and can acquire an out-of-map target", () => {
    for (const [position, expected] of [[[2.25, 1], true], [[2.2501, 1], false], [[-0.25, 1], true]]) {
        const positionOfHolder = position[0] < 0 ? [0, 1] : [2, 1];
        const battle = acquire(fixture([
            holder(10, { position: positionOfHolder, radius: 0.25 }), target(20, { position }),
        ]));
        assert.equal(ownerId(battle), expected ? 10 : undefined);
    }
});

test("ownership updates append and remove incrementally; an equivalent owner Ref preserves relation identity", () => {
    let battle = fixture([holder(10, { capacity: 3 }), target(20), target(21), target(22)]);
    const assign = (state, id, owner) => change(state, id, unit => ({ ...unit, blockable: { ...unit.blockable, blocker: owner } }));
    battle = assign(battle, 21, { id: 10 });
    battle = assign(battle, 20, { id: 10 });
    const before = getUnit(battle, 10).blocker.blocked;
    assert.deepEqual(blockedIds(battle), [21, 20]);
    battle = assign(battle, 21, { id: 10 });
    assert.equal(getUnit(battle, 10).blocker.blocked, before);
    battle = assign(battle, 21, null);
    assert.deepEqual(blockedIds(battle), [20]);
    assert.equal(getUnit(battle, 10).blocker.blocked[0], before[1]);
    battle = assign(battle, 21, { id: 10 });
    assert.deepEqual(blockedIds(battle), [20, 21]);
    assert.notEqual(getUnit(battle, 10).blocker.blocked[1], before[0]);
});

test("a direct non-null ownership transfer is a contract error", () => {
    const battle = acquire(fixture([holder(), holder(11), target()]));
    assert.throws(() => change(battle, 20, unit => ({
        ...unit, blockable: { ...unit.blockable, blocker: { id: 11 } },
    })), /release|transfer|ownership|blocker/i);
    assert.equal(ownerId(battle), 10);
});
