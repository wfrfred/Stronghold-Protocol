import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/state.js";
import { resolveMaxHp } from "../../dist/core/tactical/unit/capability/vitality/query.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { effectFixtureWork, install, maxHpBuff } from "../helpers/effects.js";

test("sequential lifecycle callbacks observe each capability change immediately", () => {
    const host = (id) => {
        const unit = initializeUnit({
            id,
            position: [id, 0],
            definition: { id: `host-${id}`, vitality: { maxHp: 100 } },
        });
        return { ...unit, vitality: { ...unit.vitality, hp: 50 } };
    };
    let battle = effectFixtureWork(host(1), host(2));
    const notices = [];
    const content = maxHpBuff("hp", 100, {
        onDisable(state, ctx) {
            notices.push([
                "disable",
                ctx.ref.unitId,
                getUnit(state, ctx.ref.unitId).vitality.hp,
                resolveMaxHp(ctx.ref.unitId, battlefieldView(state)),
            ]);
            return state;
        },
        onEnd(state, ctx) {
            notices.push(["end", ctx.ref.unitId, ctx.unit.vitality.hp]);
            return state;
        },
    });
    let parent;
    ({ state: battle, value: parent } = install(battle, content, 1));
    battle = install(battle, content, 2, { scopes: [parent] }).state;
    const before = battlefieldView(battle);
    battle = effects.end(battle, parent).state;
    assert.deepEqual(notices, [
        ["disable", 1, 50, 100],
        ["disable", 2, 50, 100],
        ["end", 2, 50],
        ["end", 1, 50],
    ]);
    assert.equal(before.getUnit(1).vitality.hp, 100);
    assert.equal(before.getUnit(2).vitality.hp, 100);
    assert.deepEqual(getUnit(battle, 1).vitality.maxHp, []);
    assert.deepEqual(getUnit(battle, 2).vitality.maxHp, []);
});
