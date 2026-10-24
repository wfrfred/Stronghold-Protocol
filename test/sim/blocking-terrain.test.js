import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBattlefieldMap } from "../../dist/data/arknights/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { create } from "../../dist/core/tactical/battlefield/state.js";
import { createBattleState, registerUnit } from "../../dist/core/tactical/battle/state.js";
import { search } from "../../dist/core/tactical/battle/blocking/operations.js";
import { blockerOf } from "../../dist/core/tactical/battle/blocking/query.js";
import { holder, target } from "../helpers/blocking.js";

function map(options = {}) {
    const tile = {
        tileKey: "tile_road",
        heightType: "LOWLAND",
        buildableType: "ALL",
        passableMask: "ALL",
        playerSideMask: "ALL",
        blackboard: [],
        effects: [],
        ...options,
    };
    return parseBattlefieldMap({ map: [[0, 0, 0]], tiles: [tile], blockEdges: [] });
}

const flag = value => [{ key: "tile_blockable", value, valueStr: null }];

test("tile blocking defaults follow height independently of navigation and deployment", () => {
    const lowland = map({ passableMask: "NONE", buildableType: "NONE" }).tiles[0];
    const highland = map({ heightType: "HIGHLAND" }).tiles[0];
    assert.equal(lowland.meleeBlockable, true);
    assert.equal(highland.meleeBlockable, false);
    assert.equal(createTile(lowland).meleeBlockable, true);
    assert.equal(createTile(highland).meleeBlockable, false);
});

test("tile_blockable overrides the height default in both directions", () => {
    assert.equal(map({ blackboard: flag(0) }).tiles[0].meleeBlockable, false);
    assert.equal(map({ heightType: "HIGHLAND", blackboard: flag(1) }).tiles[0].meleeBlockable, true);
    assert.equal(map({ heightType: "HIGHLAND", blackboard: flag(2) }).tiles[0].meleeBlockable, true);
});

for (const [name, options, expected] of [
    ["nonpassable lowland", { passableMask: "NONE", buildableType: "NONE" }, 10],
    ["passable highland", { heightType: "HIGHLAND" }, undefined],
    ["explicitly disabled lowland", { blackboard: flag(0) }, undefined],
    ["explicitly enabled highland", { heightType: "HIGHLAND", blackboard: flag(1) }, 10],
]) {
    test(`blocking search uses the tile blocking fact for ${name}`, () => {
        let battle = createBattleState(create({ map: map(options) }));
        battle = registerUnit(battle, holder(10, { position: [1, 0] }));
        battle = registerUnit(battle, target(20, { position: [1.25, 0] }));
        battle = search(battle, { id: 10 });
        assert.equal(blockerOf(battle, { id: 20 })?.id, expected);
        assert.equal(battle.events.some(event => event.type === "BLOCKING_ACQUIRED"), expected !== undefined);
    });
}
