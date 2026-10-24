import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { initializers } from "../../dist/core/tactical/unit/capability/catalog.js";
import { getUnit, registerUnit } from "../../dist/core/tactical/battle/state.js";
import { createDefinition as elementalDefinition } from "../../dist/core/tactical/unit/capability/elemental/capability.js";
import { definition as skillDefinition } from "../helpers/skill.js";
import { fixtureBattle } from "../helpers/unit.js";

const bursts = Object.fromEntries(["NEURAL", "EROSION", "BURN", "NECROSIS"].map(type => [type, {
    durationTicks: 300, onStart: battle => battle,
}]));

test("Unit initialization pairs every declared capability, including empty definitions and states", () => {
    const battle = fixtureBattle();
    const definition = {
        id: "paired-empty-capabilities",
        vitality: { maxHp: 100, defense: 0, resistance: 0 }, targetable: { restrictions: [] }, spatialPresence: {}, occupancy: {},
        tileBinding: { heightType: null, buildableType: "ALL", advancedBuildableMask: null },
    };
    const result = initialize(battle, { id: 7, definition, position: [2, 0] });
    const unit = result.value;
    assert.equal(result.state, battle);
    assert.equal(unit.definition, definition);
    assert.deepEqual(unit.targetable, { restrictions: [] });
    assert.deepEqual(unit.spatialPresence, { present: true });
    assert.deepEqual(unit.occupancy, { registration: null });
    assert.deepEqual(unit.tileBinding, {});
    assert.equal(unit.vitality.hp, 100);
    assert.equal(getUnit(battle, unit.id), undefined);
    assert.equal(getUnit(registerUnit(battle, unit), unit.id), unit);

    const bare = initialize(battle, { id: 8, definition: { id: "bare" }, position: [0, 0] }).value;
    for (const key of Object.keys(initializers)) assert.equal(Object.hasOwn(bare, key), false, key);
    for (const key of ["targetable", "spatialPresence", "occupancy"]) {
        for (const empty of [null, undefined]) {
            assert.throws(() => initialize(battle, {
                id: 9, definition: { id: "invalid-empty", [key]: empty }, position: [0, 0],
            }), new RegExp(`capability ${key} requires a definition`));
        }
    }
});

test("Skill and Elemental initialize from the current battle tick and keep shared definitions", () => {
    const battle = fixtureBattle(37);
    const skill = skillDefinition({ initialize: () => ({ count: 3 }) });
    const elemental = elementalDefinition({ maxEp: 1000, bursts });
    const definition = { id: "clocks", skill, elemental };
    const first = initialize(battle, { id: 1, definition, position: [0, 0] }).value;
    const second = initialize(battle, { id: 2, definition, position: [1, 0] }).value;
    assert.equal(first.skill.sp.lastTick, 37);
    assert.equal(first.elemental.lastAdvancedTick, 37);
    assert.deepEqual(first.skill.data, { count: 3 });
    assert.equal(first.definition, definition);
    assert.equal(second.definition, definition);
    assert.notEqual(first.skill, second.skill);
    assert.notEqual(first.skill.data, second.skill.data);
    assert.notEqual(first.elemental, second.elemental);
});

test("Unit initialization threads each capability result through the next initializer", () => {
    const originalVitality = initializers.vitality;
    const originalOffense = initializers.offense;
    const battle = fixtureBattle(5, { rngState: 17 });
    const trace = [];
    try {
        initializers.vitality = (current, definition) => {
            trace.push(["vitality", current.execution.rngState, definition.maxHp]);
            const result = originalVitality(current, definition);
            return { ...result, state: { ...result.state, execution: { ...result.state.execution, rngState: 23 } } };
        };
        initializers.offense = (current, definition) => {
            trace.push(["offense", current.execution.rngState, definition.attack]);
            const result = originalOffense(current, definition);
            return { ...result, state: { ...result.state, execution: { ...result.state.execution, rngState: 29 } } };
        };
        const result = initialize(battle, {
            id: 1, definition: { id: "threaded", vitality: { maxHp: 100, defense: 0, resistance: 0 }, offense: { attack: 7 } }, position: [0, 0],
        });
        assert.deepEqual(trace, [["vitality", 17, 100], ["offense", 23, 7]]);
        assert.equal(result.state.execution.rngState, 29);
        assert.equal(battle.execution.rngState, 17);
        assert.equal(result.value.vitality.hp, 100);
        assert.deepEqual(result.value.offense, { attack: [] });
    } finally {
        initializers.vitality = originalVitality;
        initializers.offense = originalOffense;
    }
});

test("generic Unit initialization cannot inject prepared states or override the battle clock", () => {
    const battle = fixtureBattle(19);
    const definition = { id: "no-prepared-state", vitality: { maxHp: 100, defense: 0, resistance: 0 }, elemental: elementalDefinition({ maxEp: 1000, bursts }) };
    const result = initialize(battle, {
        id: 1, definition, position: [0, 0], tick: 900,
        states: { vitality: { hp: 1 }, occupancy: { registration: { tile: [0, 0], slot: "OCCUPANT" } } },
    });
    assert.equal(result.value.vitality.hp, 100);
    assert.equal(result.value.elemental.lastAdvancedTick, 19);
    assert.equal(Object.hasOwn(result.value, "occupancy"), false);
    assert.equal(result.state, battle);
});
