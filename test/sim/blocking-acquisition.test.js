import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import * as blocker from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import * as blockable from "../../dist/core/tactical/unit/capability/blocking/blockable.js";
import {
    fixture, holder, target, change, acquire, blockedIds, ownerId, capacity, hook,
} from "../helpers/blocking.js";

const assign = (battle, unit = getUnit(battle, 20)) => updateUnit(battle, {
    ...unit,
    blockable: { ...unit.blockable, blocker: { id: 10 } },
});

const denied = [
    ["outside acquisition radius", () => [holder(), target(20, { position: [6, 1] })]],
    ["insufficient capacity", () => [holder(10, { capacity: 0 }), target()]],
    ["target volume exceeds capacity", () => [holder(), target(20, { volume: 2 })]],
    ["blocker Rule denies acquisition", () => {
        const unit = holder();
        return [{ ...unit, blocker: blocker.setRule(unit.blocker, { id: "deny", allows: () => false }) }, target()];
    }],
    ["Blockable Rule denies acquisition", () => {
        const unit = target();
        return [holder(), { ...unit, blockable: blockable.setRule(unit.blockable, { id: "deny", allows: () => false }) }];
    }],
    ["target has no HP", () => {
        const unit = target();
        return [holder(), { ...unit, vitality: { ...unit.vitality, hp: 0 } }];
    }],
    ["blocker is leaving", () => [
        { ...holder(), lifecycle: "LEAVING" }, target(),
    ]],
    ["target is not hostile", () => [holder(), target(20, { side: "ALLY" })]],
    ["target is aerial", () => {
        const unit = target();
        return [holder(), { ...unit, layer: { ...unit.layer, type: "AIR" } }];
    }],
];

for (const [name, create] of denied) {
    test(`a direct ownership update rejects ${name} before notifications`, () => {
        let battle = fixture(create());
        const calls = [];
        for (const key of ["acquired", "released"]) battle = change(battle, 10, unit => ({
            ...unit,
            blocker: blocker.setHook(unit.blocker, key, hook(key, state => {
                calls.push(key);
                return state;
            })),
        }));
        const initialOwner = getUnit(battle, 10);
        const initialTarget = getUnit(battle, 20);

        assert.throws(() => assign(battle), {
            name: "RangeError", message: "blocking ownership requires acquisition eligibility",
        });
        assert.deepEqual(calls, []);
        assert.equal(getUnit(battle, 10), initialOwner);
        assert.equal(getUnit(battle, 20), initialTarget);
        assert.deepEqual(battle.events, []);
        assert.equal(ownerId(battle), undefined);
        assert.deepEqual(blockedIds(battle), []);
        assert.equal(acquire(battle), battle, "search rejects the same invalid attempt without throwing");
    });
}

test("ownership validation uses the proposed Unit instead of its previous volume", () => {
    const battle = fixture([holder(), target()]);
    const unit = getUnit(battle, 20);
    const increased = {
        ...unit,
        blockable: blockable.setVolumeContribution(unit.blockable, { id: "larger", value: 1 }),
    };

    assert.throws(() => assign(battle, increased), /acquisition eligibility/);
    assert.equal(getUnit(battle, 20), unit);
    assert.equal(ownerId(battle), undefined);
});

test("a qualified ownership update preserves subsequent Hook changes", () => {
    let battle = fixture([holder(), target()]);
    battle = change(battle, 10, unit => ({
        ...unit,
        blocker: blocker.setHook(unit.blocker, "acquired", hook("update-target", state => change(
            state, 20, current => ({ ...current, vitality: { ...current.vitality, hp: 75 } }),
        ))),
    }));
    const initial = battle;

    battle = assign(battle);

    assert.equal(ownerId(battle), 10);
    assert.deepEqual(blockedIds(battle), [20]);
    assert.equal(getUnit(battle, 20).vitality.hp, 75);
    assert.deepEqual(battle.events.map(event => event.type), ["BLOCKING_ACQUIRED"]);
    assert.equal(getUnit(initial, 20).vitality.hp, 100);
    assert.equal(ownerId(initial), undefined);
});

test("updating a missing Unit does not trigger unrelated maintenance inside a release Hook", () => {
    let battle = fixture([holder(10, { capacity: 3 }), target(20), target(21), target(22)]);
    const missing = target(99);
    const released = [];
    battle = change(battle, 10, unit => ({
        ...unit,
        blocker: blocker.setHook(unit.blocker, "released", hook("restore-capacity", (state, { relation }) => {
            released.push(relation.blocked.id);
            if (relation.blocked.id !== 22) return state;
            assert.deepEqual(blockedIds(state), [20, 21]);
            assert.equal(updateUnit(state, missing), state);
            return capacity(state, 10, 2);
        })),
    }));

    battle = capacity(acquire(battle), 10, 1);

    assert.deepEqual(released, [22]);
    assert.deepEqual(blockedIds(battle), [20, 21]);
    assert.equal(getUnit(battle, 99), undefined);
});
