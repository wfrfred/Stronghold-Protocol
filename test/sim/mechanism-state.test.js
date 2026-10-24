import assert from "node:assert/strict";
import { test } from "node:test";
import {
    battlefieldView,
    createBattleState,
    getMechanism,
    removeMechanism,
    updateMechanism,
} from "../../dist/core/tactical/battle/state.js";
import {
    createMechanism,
    createMechanismDefinition,
} from "../../dist/core/tactical/battle/mechanism.js";
import { create } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";

function fixture() {
    const tile = createTile({
        heightType: "LOWLAND",
        meleeBlockable: true,
        buildableType: "ALL",
        passableMask: "ALL",
        playerSideMask: "ALL",
        terrain: "NORMAL",
        mechanism: null,
    });
    return createBattleState(create({ map: createBattlefieldMap(1, 1, [tile]) }));
}

function mechanism(id, active = true) {
    return createMechanism({
        id,
        definition: createMechanismDefinition({ id: `mechanism-${id}` }),
        active,
    });
}

test("mechanisms belong to BattleState rather than Battlefield State or View", () => {
    const before = fixture();
    assert.equal(before.mechanisms.size, 0);
    assert.equal(getMechanism(before, 0), undefined);
    assert.equal("mechanisms" in before.battlefield, false);
    const view = battlefieldView(before);
    assert.equal("mechanismIds" in view, false);
    assert.equal("getMechanism" in view, false);

    const self = mechanism(0);
    const after = updateMechanism(before, self);
    assert.equal(getMechanism(after, 0), self);
    assert.equal(after.mechanisms.get(0), self);
    assert.equal(after.battlefield, before.battlefield);
    assert.equal(after.execution, before.execution);
    assert.equal(after.events, before.events);
    assert.equal(before.mechanisms.size, 0);
});

test("mechanism updates preserve old snapshots and independent simulation branches", () => {
    const initial = fixture();
    const first = mechanism(1);
    const base = updateMechanism(initial, first);
    const inactive = { ...first, active: false };
    const left = updateMechanism(base, inactive);
    const other = mechanism(2);
    const right = updateMechanism(base, other);

    assert.equal(getMechanism(base, 1), first);
    assert.equal(getMechanism(left, 1), inactive);
    assert.equal(getMechanism(left, 2), undefined);
    assert.equal(getMechanism(right, 1), first);
    assert.equal(getMechanism(right, 2), other);
    assert.equal(getMechanism(base, 2), undefined);
    assert.equal(initial.mechanisms.size, 0);
    for (const branch of [base, left, right]) {
        assert.equal(branch.battlefield, initial.battlefield);
    }
});

test("mechanism replacement preserves registration order while re-registration appends", () => {
    let battle = fixture();
    const first = mechanism(7);
    const second = mechanism(3);
    battle = updateMechanism(updateMechanism(battle, first), second);
    const before = battle;
    battle = updateMechanism(battle, { ...first, active: false });
    assert.deepEqual([...battle.mechanisms.keys()], [7, 3]);
    battle = removeMechanism(battle, first.id);
    assert.deepEqual([...battle.mechanisms.keys()], [3]);
    battle = updateMechanism(battle, first);
    assert.deepEqual([...battle.mechanisms.keys()], [3, 7]);
    assert.deepEqual([...before.mechanisms.keys()], [7, 3]);
    assert.equal(getMechanism(before, 7), first);
    assert.equal(battle.battlefield, before.battlefield);
});

test("same-object updates and missing removals are complete no-ops", () => {
    const empty = fixture();
    assert.equal(removeMechanism(empty, 0), empty);
    const self = mechanism(0);
    const battle = updateMechanism(empty, self);
    assert.equal(updateMechanism(battle, self), battle);
    assert.equal(removeMechanism(battle, 99), battle);
    const removed = removeMechanism(battle, self.id);
    assert.equal(getMechanism(removed, self.id), undefined);
    assert.equal(removeMechanism(removed, self.id), removed);
    assert.equal(getMechanism(battle, self.id), self);
    assert.equal(removed.battlefield, battle.battlefield);
});

test("mechanism updates cannot replace the registered Definition identity", () => {
    const self = mechanism(0);
    const battle = updateMechanism(fixture(), self);
    assert.throws(() => updateMechanism(battle, {
        ...self,
        definition: createMechanismDefinition({ id: self.definition.id }),
    }), RangeError);
    assert.equal(getMechanism(battle, self.id), self);
    assert.equal(battle.mechanisms.size, 1);
});

test("mechanism registration rejects invalid identities without changing the simulation", () => {
    const battle = fixture();
    const self = mechanism(0);
    for (const id of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => updateMechanism(battle, { ...self, id }), RangeError);
    }
    assert.equal(battle.mechanisms.size, 0);
    assert.equal(getMechanism(battle, 0), undefined);
    const last = { ...self, id: Number.MAX_SAFE_INTEGER };
    const registered = updateMechanism(battle, last);
    assert.equal(getMechanism(registered, last.id), last);
    assert.equal(registered.battlefield, battle.battlefield);
});

test("BattleStates created from the same Battlefield own independent mechanism state", () => {
    const first = fixture();
    const second = createBattleState(first.battlefield);
    const self = mechanism(0);
    const updated = updateMechanism(first, self);
    assert.equal(getMechanism(updated, 0), self);
    assert.equal(second.mechanisms.size, 0);
    assert.equal(getMechanism(second, 0), undefined);
    assert.equal(updated.battlefield, second.battlefield);
});
