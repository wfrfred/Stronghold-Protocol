import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../helpers/unit.js";
import {
    advanceBattlefield,
    battlefieldView,
    createBattleState,
    getUnit,
    removeUnit,
    updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { create as createBattlefield } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { applyBattlefieldChanges } from "../../dist/core/tactical/battlefield/storage/changes.js";
import { settleBattlefieldStateFully } from "../../dist/core/tactical/battlefield/storage/state.js";
import * as blocker from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import * as blockable from "../../dist/core/tactical/unit/capability/blocking/blockable.js";
import * as locomotion from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { advance } from "../../dist/core/tactical/unit/capability/locomotion/operations.js";
import * as presence from "../../dist/core/tactical/unit/capability/presence/operations.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/attribute.js";

const blockingRuleId = "@blocking/blocked";
const context = { mode: "WALK", speedMultiplier: 1 };
const blockingRule = (unit) => unit.locomotion.rules.find((rule) => rule.id === blockingRuleId);
const relation = (blockerUnitId, blockedUnitId) => ({ blockerUnitId, blockedUnitId });
const register = (units) => units.map((unit) => ({ type: "REGISTER_UNIT", unit }));

function fixture(units = []) {
    const tile = createTile({
        heightType: "LOWLAND", buildableType: "ALL", passableMask: "ALL",
        playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
    });
    const map = createBattlefieldMap(3, 10, Array(30).fill(tile));
    return advanceBattlefield(createBattleState(createBattlefield({ map })), register(units));
}

const holder = (id = 10, { position = [2, 1], capacity = 1 } = {}) => initialize({
    id, position, definition: {
        id: `movement-rule-holder-${id}`,
        allegiance: { side: "ALLY" }, spatialPresence: {},
        vitality: { maxHp: 100, defense: 0, resistance: 0 },
        blocker: { capacity, geometry: { radius: 1 } },
    },
});

const mover = (id = 20, { position = [2.25, 1], volume = 1, rules = [] } = {}) => {
    const unit = initialize({
        id, position, definition: {
            id: `movement-rule-target-${id}`,
            allegiance: { side: "ENEMY" }, spatialPresence: {},
            spatial: { layer: "GROUND" }, blockable: { volume },
            locomotion: {
                speed: 0.125, minSpeed: 0, halfBodyWidth: 0,
                steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
            },
        },
    });
    return { ...unit, locomotion: { ...unit.locomotion, rules } };
};

function step(battle, id = 20, mode = "WALK") {
    const unit = getUnit(battle, id);
    const goal = [8, unit.position[1]];
    return advance(battle, { id }, { nextPoint: goal, goal }, { ...context, mode });
}

function assertStopped(battle, id = 20) {
    assert.equal(step(battle, id), battle, `unit ${id} must remain immobile`);
}

function assertMoves(battle, id = 20, mode = "WALK") {
    const previous = getUnit(battle, id);
    const moved = getUnit(step(battle, id, mode), id);
    assert.ok(moved.position[0] > previous.position[0], `unit ${id} must move after release`);
    assert.deepEqual(previous.position, getUnit(battle, id).position);
}

function change(battle, id, transition) {
    return updateUnit(battle, transition(getUnit(battle, id)));
}

test("Blocking automatically installs one shared movement rule without changing registered snapshots", () => {
    const first = mover(20);
    const second = mover(21);
    const stationary = initialize({
        id: 22, position: [2.5, 1],
        definition: { id: "stationary-blockable", allegiance: { side: "ENEMY" }, blockable: { volume: 1 } },
    });
    let battle = fixture([holder(10, { capacity: 3 }), first, second, stationary]);
    assert.deepEqual(battlefieldView(battle).blockedBy(10), [20, 21, 22]);
    const rule = blockingRule(getUnit(battle, 20));
    assert.ok(rule);
    assert.equal(blockingRule(getUnit(battle, 21)), rule);
    assert.equal(getUnit(battle, 20).locomotion.rules.length, 1);
    assert.equal(rule.allows(battle, getUnit(battle, 20)), false);
    assert.equal(getUnit(battle, 22), stationary);
    assert.deepEqual(first.locomotion.rules, []);
    assert.deepEqual(second.locomotion.rules, []);
    assertStopped(battle, 20);
    assertStopped(battle, 21);

    const current = getUnit(battle, 20);
    battle = advanceBattlefield(battle, register([initialize({
        id: 30, position: [9, 1], definition: { id: "unrelated-unit" },
    })]));
    assert.equal(getUnit(battle, 20), current, "an existing rule must not rebuild an unchanged unit");
    assert.equal(blockingRule(getUnit(battle, 20)), rule);
});

test("Blocking release reacquires in the same settlement, and moving out of range removes the rule", () => {
    let battle = fixture([holder(), mover()]);
    const rule = blockingRule(getUnit(battle, 20));
    battle = advanceBattlefield(battle, [{ type: "RELEASE_BLOCKING_RELATIONS", unitId: 20 }]);
    assert.equal(battlefieldView(battle).blockerOf(20), 10);
    assert.equal(blockingRule(getUnit(battle, 20)), rule);
    assert.equal(getUnit(battle, 20).locomotion.rules.length, 1);
    assertStopped(battle);

    battle = advanceBattlefield(battle, [{
        type: "SET_POSITION_AND_RELEASE_BLOCKING", unitId: 20, position: [6, 1],
    }]);
    assert.equal(battlefieldView(battle).blockerOf(20), undefined);
    assert.equal(blockingRule(getUnit(battle, 20)), undefined);
    assertMoves(battle);

    battle = change(battle, 20, (unit) => ({ ...unit, position: [2.25, 1] }));
    assert.equal(blockingRule(getUnit(battle, 20)), rule);
    assertStopped(battle);
});

test("Removing a blocker transfers the relation without losing the rule, then releases movement", () => {
    let battle = fixture([holder(), holder(11, { position: [3, 1] }), mover()]);
    const previous = battle;
    const rule = blockingRule(getUnit(battle, 20));
    battle = removeUnit(battle, 10, "RETREAT");
    assert.equal(battlefieldView(battle).blockerOf(20), 11);
    assert.equal(blockingRule(getUnit(battle, 20)), rule);
    assertStopped(battle);
    assert.equal(battlefieldView(previous).blockerOf(20), 10);
    assertStopped(previous);

    battle = removeUnit(battle, 11, "DEATH");
    assert.equal(blockingRule(getUnit(battle, 20)), undefined);
    assertMoves(battle);
});

test("Changing a blocked target to AIR removes the movement rule and landing reacquires it", () => {
    let battle = fixture([holder(), mover()]);
    const rule = blockingRule(getUnit(battle, 20));
    battle = change(battle, 20, (unit) => ({ ...unit, spatial: { layer: "AIR" } }));
    assert.equal(battlefieldView(battle).blockerOf(20), undefined);
    assert.equal(blockingRule(getUnit(battle, 20)), undefined);
    assertMoves(battle, 20, "FLY");
    battle = change(battle, 20, (unit) => ({ ...unit, spatial: { layer: "GROUND" } }));
    assert.equal(blockingRule(getUnit(battle, 20)), rule);
    assertStopped(battle);
});

test("Spatial disappearance removes rules and appearance only restores them when blocking is acquired", () => {
    let battle = fixture([holder(), mover()]);
    battle = presence.disappear(battle, { id: 10 });
    assert.equal(blockingRule(getUnit(battle, 20)), undefined);
    assertMoves(battle);
    battle = presence.appear(battle, { id: 10 }, [2, 1]);
    assert.ok(blockingRule(getUnit(battle, 20)));
    assertStopped(battle);

    battle = presence.disappear(battle, { id: 20 });
    assert.equal(blockingRule(getUnit(battle, 20)), undefined);
    assertStopped(battle);
    battle = presence.appear(battle, { id: 20 }, [6, 1]);
    assert.equal(blockingRule(getUnit(battle, 20)), undefined);
    assertMoves(battle);
});

test("Capacity and volume changes keep movement rules aligned with the fitting retained relations", () => {
    let battle = fixture([holder(10, { capacity: 3 }), mover(20, { volume: 2 }), mover(21)]);
    assertStopped(battle, 20);
    assertStopped(battle, 21);
    battle = change(battle, 10, (unit) => ({
        ...unit, blocker: blocker.setCapacityContribution(unit.blocker, {
            id: "capacity-reduction", value: [modifier({ addition: -2 })],
        }),
    }));
    assert.deepEqual(battlefieldView(battle).blockedBy(10), [21]);
    assert.equal(blockingRule(getUnit(battle, 20)), undefined);
    assertMoves(battle, 20);
    assertStopped(battle, 21);

    battle = change(battle, 10, (unit) => ({
        ...unit, blocker: blocker.removeCapacityContribution(unit.blocker, "capacity-reduction"),
    }));
    assert.deepEqual(battlefieldView(battle).blockedBy(10), [21, 20]);
    assertStopped(battle, 20);
    battle = change(battle, 20, (unit) => ({
        ...unit, blockable: blockable.setVolumeContribution(unit.blockable, { id: "larger", value: 2 }),
    }));
    assert.deepEqual(battlefieldView(battle).blockedBy(10), [21]);
    assert.equal(blockingRule(getUnit(battle, 20)), undefined);
    assertMoves(battle, 20);
    battle = change(battle, 20, (unit) => ({
        ...unit, blockable: blockable.removeVolumeContribution(unit.blockable, "larger"),
    }));
    assertStopped(battle, 20);
    assertStopped(battle, 21);
});

test("Blocking removes only its own rule and preserves other movement restrictions", () => {
    const casting = { id: "casting", allows: () => false };
    const allowed = { id: "other-permission", allows: () => true };
    let battle = fixture([holder(), mover(20, { rules: [casting, allowed] })]);
    assert.equal(getUnit(battle, 20).locomotion.rules.length, 3);
    assertStopped(battle);
    battle = removeUnit(battle, 10, "SCRIPT");
    assert.deepEqual(getUnit(battle, 20).locomotion.rules, [casting, allowed]);
    assertStopped(battle);
    battle = change(battle, 20, (unit) => ({
        ...unit, locomotion: locomotion.removeRule(unit.locomotion, casting.id),
    }));
    assert.deepEqual(getUnit(battle, 20).locomotion.rules, [allowed]);
    assertMoves(battle);
});

test("UPDATE_UNIT restores a missing Blocking rule even when the relation and blocking facts do not change", () => {
    const unblocked = mover();
    let battle = fixture([holder(), unblocked]);
    const relations = battle.battlefield.blockingRelations;
    const rule = blockingRule(getUnit(battle, 20));
    battle = updateUnit(battle, unblocked);
    assert.equal(battle.battlefield.blockingRelations, relations);
    assert.equal(blockingRule(getUnit(battle, 20)), rule);
    assertStopped(battle);

    const other = { id: "another-rule", allows: () => true };
    battle = change(battle, 20, (unit) => ({
        ...unit, locomotion: { ...unit.locomotion, rules: [other] },
    }));
    assert.equal(battle.battlefield.blockingRelations, relations);
    assert.equal(blockingRule(getUnit(battle, 20)), rule);
    assert.equal(getUnit(battle, 20).locomotion.rules.find((entry) => entry.id === other.id), other);
    assert.equal(getUnit(battle, 20).locomotion.rules.length, 2);
    assertStopped(battle);
});

test("Blocking rule settlement preserves prior Unit, Locomotion and rule-array snapshots", () => {
    const original = mover();
    const blocked = fixture([holder(), original]);
    const oldMap = blocked.battlefield.units;
    const oldUnit = getUnit(blocked, 20);
    const oldLocomotion = oldUnit.locomotion;
    const oldRules = oldLocomotion.rules;
    const oldRule = blockingRule(oldUnit);
    const released = change(blocked, 10, (unit) => ({
        ...unit, vitality: { ...unit.vitality, hp: 0 },
    }));
    assert.equal(blocked.battlefield.units, oldMap);
    assert.equal(getUnit(blocked, 20), oldUnit);
    assert.equal(oldUnit.locomotion, oldLocomotion);
    assert.equal(oldLocomotion.rules, oldRules);
    assert.deepEqual(oldRules, [oldRule]);
    assert.deepEqual(original.locomotion.rules, []);
    assert.deepEqual(battlefieldView(blocked).blockingRelations, [relation(10, 20)]);
    assert.equal(blockingRule(getUnit(released, 20)), undefined);
    assert.notEqual(released.battlefield.units, oldMap);
    assertStopped(blocked);
    assertMoves(released);
});

test("Incremental and full settlement publish the same rules and movement across relation and unit changes", () => {
    const initial = fixture();
    const branches = [initial, initial];
    const snapshot = (battle) => JSON.stringify(battle.battlefield, (_key, value) =>
        value instanceof Map || value instanceof Set ? [...value] : value);
    const commit = (changes, blockedIds) => {
        const batch = typeof changes === "function" ? changes(branches[0]) : changes;
        for (let index = 0; index < branches.length; index++) {
            const previous = branches[index];
            const oldSnapshot = snapshot(previous);
            if (index === 0) {
                branches[index] = advanceBattlefield(previous, batch);
            } else {
                const applied = applyBattlefieldChanges(previous.battlefield, batch);
                const settled = settleBattlefieldStateFully(
                    previous.battlefield.map, previous.battlefield, applied.content,
                );
                branches[index] = {
                    ...previous,
                    battlefield: { map: previous.battlefield.map, ...settled.state },
                    removedUnits: [...previous.removedUnits, ...applied.facts.removedUnits],
                };
            }
            assert.equal(snapshot(previous), oldSnapshot, "settlement must preserve its previous state");
            for (const id of [20, 21]) {
                const unit = getUnit(branches[index], id);
                assert.equal(blockingRule(unit) !== undefined, blockedIds.includes(id));
                if (blockedIds.includes(id)) assertStopped(branches[index], id);
                else assertMoves(branches[index], id, unit.spatial.layer === "AIR" ? "FLY" : "WALK");
            }
        }
        assert.deepEqual(branches[0].battlefield, branches[1].battlefield);
    };
    const update = (id, transition) => (battle) => [{
        type: "UPDATE_UNIT", unit: transition(getUnit(battle, id)),
    }];
    commit(register([holder(10, { capacity: 2 }), mover(20), mover(21)]), [20, 21]);
    commit(update(20, (unit) => ({ ...unit, locomotion: { ...unit.locomotion, rules: [] } })), [20, 21]);
    commit([{ type: "RELEASE_BLOCKING_RELATIONS", unitId: 10 }], [20, 21]);
    commit(update(20, (unit) => ({ ...unit, spatial: { layer: "AIR" } })), [21]);
    commit(update(20, (unit) => ({ ...unit, spatial: { layer: "GROUND" } })), [20, 21]);
    commit(update(10, (unit) => ({
        ...unit, blocker: blocker.setCapacityContribution(unit.blocker, {
            id: "less-capacity", value: [modifier({ addition: -1 })],
        }),
    })), [21]);
    commit([{ type: "REMOVE_UNIT", unitId: 10, reason: "SCRIPT" }], []);
    commit([{ type: "REGISTER_UNIT", unit: holder(11, { position: [3, 1], capacity: 2 }) }], [20, 21]);
    commit([{ type: "SET_POSITION_AND_RELEASE_BLOCKING", unitId: 20, position: [6, 1] }], [21]);
    commit([{ type: "SET_BLOCKING_RELATIONS", relations: [relation(11, 20), relation(11, 21)] }], [20, 21]);
    commit(update(20, (unit) => ({
        ...unit, blockable: blockable.setVolumeContribution(unit.blockable, { id: "too-large", value: 2 }),
    })), [21]);
});
