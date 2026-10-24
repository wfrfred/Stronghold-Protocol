import { get as unitQueryGet } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../helpers/unit.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/state.js";
import { resolveMaxHp } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { effectFixtureWork, install, maxHpBuff } from "../helpers/effects.js";

test("sequential lifecycle callbacks observe each capability change immediately", () => {
    const host = (id) => {
        const unit = initialize({
            id,
            position: [id, 0],
            definition: { id: `host-${id}`, vitality: { maxHp: 100, defense: 0, resistance: 0 } },
        });
        return { ...unit, vitality: { ...unit.vitality, hp: 50 } };
    };
    let battle = effectFixtureWork(host(1), host(2));
    const notices = [];
    const content = maxHpBuff("hp", 100, {
        onDisable(state, self) {
            const unit = getUnit(state, self.host.id);
            notices.push([
                "disable",
                self.host.id,
                unit.vitality.hp,
                resolveMaxHp(unit.vitality, unit.definition.vitality),
            ]);
            return state;
        },
        onEnd(state, self) {
            notices.push(["end", self.host.id, unitQueryGet(state, self.host).vitality.hp]);
            return state;
        },
    });
    let parent;
    ({ state: battle, value: parent } = install(battle, content, 1));
    battle = install(battle, content, 2, { scopes: [{ type: "EFFECT", ref: parent }] }).state;
    const before = battlefieldView(battle);
    battle = effects.end(battle, parent);
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
