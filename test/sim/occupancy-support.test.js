import { view } from "../../dist/core/tactical/battlefield/view.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as field from "../../dist/core/tactical/battlefield/state.js";
import { at } from "../../dist/core/tactical/battlefield/occupancy.js";
import * as support from "../../dist/core/tactical/battlefield/support.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import {
    createBattleState, getUnit, setBattlefield, updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { createDefinition as actionDefinition } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { createDefinition as tileBinding } from "../../dist/core/tactical/unit/capability/tile-binding/capability.js";
import { initialize } from "../helpers/unit.js";

const map = createBattlefieldMap(2, 3, Array.from({ length: 6 }, () => createTile({
    heightType: "LOWLAND", meleeBlockable: true, buildableType: "ALL", passableMask: "ALL",
    playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
})));

function unit(id, tile = [0, 0], slot = "OCCUPANT", definition = {}, states = {}) {
    return initialize({
        id, position: [tile[1], tile[0]],
        definition: {
            id: `occupancy-${id}`, occupancy: {}, spatialPresence: {},
            vitality: { maxHp: 100, defense: 0, resistance: 0 },
            ...definition,
        },
        states: { occupancy: { registration: { tile, slot } }, ...states },
    });
}

function platform(id = 10, onSupportLost, tile = [0, 0]) {
    return unit(id, tile, "SUPPORT", {
        tileBinding: tileBinding({
            heightType: "HIGHLAND", buildableType: "ALL",
            ...(onSupportLost === undefined ? {} : { onSupportLost }),
        }),
    });
}

function fixture(instances = [platform(), unit(20)]) {
    let current = field.create({ map });
    for (const instance of instances) current = field.addUnit(current, instance);
    return createBattleState(current);
}

const losses = battle => battle.events.filter(event => event.type === "SUPPORT_LOST");
const withoutRegistration = current => ({ ...current, occupancy: { registration: null } });

test("empty registration and empty tiles have no occupancy entry", () => {
    const initialized = initialize({ id: 1, definition: { id: "empty", occupancy: {} }, position: [0, 0] });
    assert.deepEqual(initialized.occupancy, { registration: null });
    const current = field.addUnit(field.create({ map }), initialized);
    assert.equal(current.occupancy.size, 0);
    assert.equal(at(current, [0, 0]), undefined);
    assert.equal(at(current, [2, 0]), undefined);
});

test("one tile independently registers an occupant and a support with typed identities", () => {
    const battle = fixture();
    const entry = at(battle.battlefield, [0, 0]);
    assert.equal(entry.occupant.id, 20);
    assert.equal(entry.support.id, 10);
    assert.equal(battle.battlefield.occupancy.size, 1);
    assert.equal("supportRelations" in battle.battlefield, false);
    assert.deepEqual(view(battle.battlefield).unitsAt([0, 0]).map(unit => unit.id), [10, 20]);
    assert.equal(support.of(battle.battlefield, entry.occupant).support, getUnit(battle, 10));
});

test("out-of-bounds queries cannot alias a valid flattened tile key", () => {
    const battle = fixture([unit(20, [1, 0])]);
    assert.equal(at(battle.battlefield, [0, 3]), undefined);
    assert.equal(at(battle.battlefield, [1, -3]), undefined);
    assert.equal(at(battle.battlefield, [1, 0]).occupant.id, 20);
});

test("out-of-bounds registration and conflicting slots reject without mutating the input", () => {
    const battle = fixture();
    assert.throws(() => field.addUnit(battle.battlefield, unit(21)), RangeError);
    assert.throws(() => field.addUnit(battle.battlefield, unit(21, [0, 3])), RangeError);
    assert.throws(() => field.replaceUnit(battle.battlefield, {
        ...getUnit(battle, 20), occupancy: { registration: { tile: [0, 0], slot: "SUPPORT" } },
    }), RangeError);
    assert.equal(battle.battlefield.units.size, 2);
    assert.equal(at(battle.battlefield, [0, 0]).occupant.id, 20);
    assert.equal(at(battle.battlefield, [0, 0]).support.id, 10);
});

test("value-equal registration preserves the reverse index while updating the Unit", () => {
    const battle = fixture();
    const previous = battle.battlefield;
    const occupant = getUnit(battle, 20);
    const next = field.replaceUnit(previous, {
        ...occupant, vitality: { ...occupant.vitality, hp: 75 },
        occupancy: { registration: { tile: [0, 0], slot: "OCCUPANT" } },
    });
    assert.equal(next.units.get(20).vitality.hp, 75);
    assert.equal(next.occupancy, previous.occupancy);
    assert.equal(at(next, [0, 0]), at(previous, [0, 0]));
    assert.equal(support.of(next, { id: 20 }).occupant, next.units.get(20));
    assert.equal(previous.units.get(20).vitality.hp, 100);
});

test("ordinary Unit updates do not enumerate unchanged occupancy to find lost supports", () => {
    let enumerations = 0;
    class MeasuredOccupancy extends Map {
        values() {
            enumerations++;
            return super.values();
        }
    }
    const initial = fixture();
    const occupancy = new MeasuredOccupancy(initial.battlefield.occupancy);
    const battle = { ...initial, battlefield: { ...initial.battlefield, occupancy } };
    const occupant = getUnit(battle, 20);
    const next = updateUnit(battle, {
        ...occupant, vitality: { ...occupant.vitality, hp: 75 },
    });
    assert.equal(enumerations, 0);
    assert.equal(next.battlefield.occupancy, occupancy);
    assert.equal(getUnit(next, 20).vitality.hp, 75);
    assert.equal(getUnit(battle, 20).vitality.hp, 100);
    assert.deepEqual(losses(next), []);
});

test("moving and clearing registrations preserve the other slot and delete empty entries", () => {
    let current = fixture().battlefield;
    const previous = current;
    current = field.replaceUnit(current, {
        ...current.units.get(20), occupancy: { registration: { tile: [0, 1], slot: "OCCUPANT" } },
    });
    assert.equal(at(current, [0, 0]).occupant, null);
    assert.equal(at(current, [0, 0]).support.id, 10);
    assert.equal(at(current, [0, 1]).occupant.id, 20);
    current = field.removeUnit(current, { id: 10 });
    assert.equal(at(current, [0, 0]), undefined);
    current = field.replaceUnit(current, withoutRegistration(current.units.get(20)));
    assert.equal(current.occupancy.size, 0);
    assert.equal(current.units.has(20), true);
    assert.equal(at(previous, [0, 0]).occupant.id, 20);
});

test("registration and support are independent of body position and spatial disappearance", () => {
    let battle = fixture();
    const occupancy = battle.battlefield.occupancy;
    for (const id of [10, 20]) {
        const current = getUnit(battle, id);
        battle = updateUnit(battle, {
            ...current, position: [100, 100], spatialPresence: { present: false },
        });
    }
    assert.equal(battle.battlefield.occupancy, occupancy);
    assert.equal(support.of(battle.battlefield, { id: 20 }).support.id, 10);
    assert.deepEqual(losses(battle), []);
});

test("a SUPPORT registration alone does not provide TileBinding support", () => {
    const battle = fixture([unit(10, [0, 0], "SUPPORT"), unit(20)]);
    assert.equal(at(battle.battlefield, [0, 0]).support.id, 10);
    assert.equal(support.of(battle.battlefield, { id: 20 }), undefined);
});

for (const [name, change, expected] of [
    ["the platform unregisters", battle => updateUnit(battle, withoutRegistration(getUnit(battle, 10))), 1],
    ["the platform leaves", battle => leave(battle, 10, "SCRIPT"), 1],
    ["the occupant changes registered tile", battle => updateUnit(battle, {
        ...getUnit(battle, 20), occupancy: { registration: { tile: [0, 1], slot: "OCCUPANT" } },
    }), 1],
    ["the occupant leaves", battle => leave(battle, 20, "SCRIPT"), 0],
    ["the occupant only becomes spatially absent", battle => updateUnit(battle, {
        ...getUnit(battle, 20), spatialPresence: { present: false },
    }), 0],
    ["the platform only becomes spatially absent", battle => updateUnit(battle, {
        ...getUnit(battle, 10), spatialPresence: { present: false },
    }), 0],
    ["the pair persists across a HP update", battle => updateUnit(battle, {
        ...getUnit(battle, 20), vitality: { ...getUnit(battle, 20).vitality, hp: 50 },
    }), 0],
]) test(`SUPPORT_LOST follows the pair difference when ${name}`, () => {
    const battle = change(fixture());
    assert.equal(losses(battle).length, expected);
    if (expected) assert.deepEqual(losses(battle)[0], {
        type: "SUPPORT_LOST", supportedUnitId: 20, supportUnitId: 10, tick: 0,
    });
});

test("a replacement platform emits the old pair loss even when the occupant retains support", () => {
    const calls = [];
    const first = platform(10, (battle, self, loss) => {
        calls.push([self.id, loss.occupant.id, support.of(battle.battlefield, loss.occupant).support.id]);
        return battle;
    });
    let battle = fixture([first, unit(20), withoutRegistration(platform(11))]);
    let next = field.replaceUnit(battle.battlefield, withoutRegistration(getUnit(battle, 10)));
    next = field.replaceUnit(next, {
        ...getUnit(battle, 11), occupancy: { registration: { tile: [0, 0], slot: "SUPPORT" } },
    });
    battle = setBattlefield(battle, next);
    assert.deepEqual(calls, [[10, 20, 11]]);
    assert.deepEqual(losses(battle).map(event => [event.supportUnitId, event.supportedUnitId]), [[10, 20]]);
    assert.equal(getUnit(battle, 20).lifecycle, "PRESENT");
});

test("support loss invokes the removed provider's content synchronously and performs full Unit cleanup", () => {
    const trace = [];
    const action = {
        id: "ongoing", intervalTicks: 30, speed: 100,
        initialize: battle => ({ state: battle, value: {} }),
        start: battle => ({ state: battle, value: {} }),
        step: battle => ({ state: battle, value: false }),
        onEnd: battle => { trace.push("action ended"); return battle; },
    };
    const provider = platform(10, (battle, self, loss) => {
        assert.equal(self.id, provider.id);
        assert.equal(self.definition, provider.definition);
        assert.equal(self.lifecycle, "LEAVING");
        assert.equal(getUnit(battle, self.id), undefined);
        assert.deepEqual(loss.tile, [0, 0]);
        assert.equal(losses(battle).length, 1);
        assert.equal(at(battle.battlefield, loss.tile).support, null);
        assert.equal(at(battle.battlefield, loss.tile).occupant.id, loss.occupant.id);
        trace.push("support lost");
        return leave(battle, loss.occupant.id, "SCRIPT");
    });
    let battle = fixture([provider, unit(20, [0, 0], "OCCUPANT", {
        action: actionDefinition({ definitions: Definitions.empty().add(action) }),
        onLeave: current => { trace.push("occupant left"); return current; },
    })]);
    battle = actions.start(battle, { id: 20 }, action).state;
    battle = effects.install(battle, { id: 20 }, {
        id: "dependent", initialize: () => ({}),
        onEnd: current => { trace.push("effect ended"); return current; },
    }).state;
    const previous = battle;
    battle = leave(battle, 10, "SCRIPT");
    assert.equal(getUnit(battle, 10), undefined);
    assert.equal(getUnit(battle, 20), undefined);
    assert.equal(battle.battlefield.occupancy.size, 0);
    assert.deepEqual(trace, ["support lost", "action ended", "effect ended", "occupant left"]);
    assert.deepEqual(battle.removedUnits.map(entry => entry.unitId), [20, 10]);
    assert.equal(previous.battlefield.units.size, 2);
});

test("a support-loss callback updates the latest occupant without an outer stale write", () => {
    const provider = platform(10, (battle, _self, loss) => updateUnit(battle, {
        ...getUnit(battle, loss.occupant.id),
        vitality: { ...getUnit(battle, loss.occupant.id).vitality, hp: 35 },
    }));
    let battle = fixture([provider, unit(20)]);
    battle = updateUnit(battle, {
        ...getUnit(battle, 20),
        occupancy: { registration: { tile: [0, 1], slot: "OCCUPANT" } },
        vitality: { ...getUnit(battle, 20).vitality, hp: 80 },
    });
    assert.equal(getUnit(battle, 20).vitality.hp, 35);
    assert.deepEqual(getUnit(battle, 20).occupancy.registration.tile, [0, 1]);
    assert.equal(losses(battle).length, 1);
});

test("support-loss callbacks observe completed blocking ownership and can immediately end it", () => {
    const provider = platform(10, (battle, _self, loss) => {
        assert.equal(getUnit(battle, loss.occupant.id).blockable.blocker.id, 30);
        assert.equal(getUnit(battle, 30).blocker.blocked[0].id, loss.occupant.id);
        return leave(battle, loss.occupant.id, "SCRIPT");
    });
    const occupant = unit(20, [0, 0], "OCCUPANT", {
        blockable: { volume: 1 }, allegiance: { side: "ENEMY" }, layer: { type: "GROUND" },
    });
    const holder = initialize({
        id: 30, position: [0, 0], definition: {
            id: "holder", blocker: { capacity: 1, geometry: { radius: 1 } },
            allegiance: { side: "ALLY" }, vitality: { maxHp: 100, defense: 0, resistance: 0 },
        },
    });
    let battle = fixture([provider, occupant, holder]);
    battle = updateUnit(battle, {
        ...getUnit(battle, 20), occupancy: { registration: null },
        blockable: { ...getUnit(battle, 20).blockable, blocker: { id: 30 } },
    });
    assert.equal(getUnit(battle, 20), undefined);
    assert.deepEqual(getUnit(battle, 30).blocker.blocked, []);
    assert.deepEqual(battle.events.filter(event => event.type.startsWith("BLOCKING_")).map(event => event.type), [
        "BLOCKING_ACQUIRED", "BLOCKING_RELEASED",
    ]);
});

test("a support-loss callback can restore registration without an outer update removing it again", () => {
    let calls = 0;
    const provider = platform(10, (battle, self, loss) => {
        calls++;
        assert.equal(at(battle.battlefield, loss.tile).support, null);
        return updateUnit(battle, {
            ...getUnit(battle, self.id),
            occupancy: { registration: { tile: loss.tile, slot: "SUPPORT" } },
        });
    });
    let battle = fixture([provider, unit(20)]);
    battle = updateUnit(battle, withoutRegistration(getUnit(battle, 10)));
    assert.equal(calls, 1);
    assert.equal(support.of(battle.battlefield, { id: 20 }).support.id, 10);
    assert.equal(losses(battle).length, 1);
});

test("loss candidates remain historical facts while each callback receives the latest BattleState", () => {
    const trace = [];
    const first = platform(10, (battle, self, loss) => {
        trace.push([self.id, loss.occupant.id]);
        return leave(battle, 21, "SCRIPT");
    });
    const second = platform(11, (battle, self, loss) => {
        assert.equal(getUnit(battle, loss.occupant.id), undefined);
        assert.equal(losses(battle).length, 2);
        trace.push([self.id, loss.occupant.id]);
        return battle;
    }, [0, 1]);
    let battle = fixture([first, unit(20), second, unit(21, [0, 1])]);
    let next = field.replaceUnit(battle.battlefield, withoutRegistration(getUnit(battle, 10)));
    next = field.replaceUnit(next, withoutRegistration(getUnit(battle, 11)));
    battle = setBattlefield(battle, next);
    assert.deepEqual(trace, [[10, 20], [11, 21]]);
    assert.deepEqual(losses(battle).map(event => [event.supportUnitId, event.supportedUnitId]), [
        [10, 20], [11, 21],
    ]);
    assert.equal(getUnit(battle, 21), undefined);
});
