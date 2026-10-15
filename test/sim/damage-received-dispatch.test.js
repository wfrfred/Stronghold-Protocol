import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { setHook, removeHook } from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { effectFixtureWork } from "../helpers/effects.js";

const hook = (id, invoke, enabled = () => true) => ({ id, stage: "received", enabled, invoke });
const change = (battle, transform) => {
    const unit = getUnit(battle, 0);
    return updateUnit(battle, { ...unit, vitality: transform(unit.vitality) });
};
function fixture(hooks) {
    const unit = initialize({ id: 0, position: [0, 0], definition: { id: "receiver", vitality: { maxHp: 100 } } });
    return change(effectFixtureWork(unit), vitality => ({ ...vitality, damageHooks: hooks }));
}
const damage = (battle, power = 1) => resolveDamage(battle, {
    sourceUnitId: null, targetUnitId: 0, damageType: "TRUE", operands: createDamageOperands(power), tick: battle.tick,
}).state;

for (const enabled of [true, false]) {
    test(`received dispatch uses a replacement's current enabled=${enabled} and program`, () => {
        const seen = [];
        const replacement = hook("B", battle => { seen.push("new B"); return battle; }, (_battle, self, event) => {
            seen.push(["new enabled", self.vitality.hp, event.pending.amount]);
            return enabled;
        });
        const state = fixture([
            hook("A", battle => {
                seen.push("A");
                return change(battle, vitality => setHook({ ...vitality, hp: 90 }, replacement));
            }),
            hook("B", battle => { seen.push("old B"); return battle; }, () => {
                seen.push("old enabled");
                return !enabled;
            }),
        ]);
        const settled = damage(state);
        assert.deepEqual(seen, ["A", ["new enabled", 90, 1], ...(enabled ? ["new B"] : [])]);
        assert.equal(getUnit(settled, 0).vitality.hp, 89);
        assert.equal(getUnit(state, 0).vitality.hp, 100);
    });
}

test("received dispatch skips a removed ID and a replacement in a different stage", () => {
    const seen = [];
    const state = fixture([
        hook("A", battle => {
            seen.push("A");
            return change(battle, vitality => setHook(removeHook(vitality, "B"), {
                id: "C", stage: "reaction", priority: 0, enabled: () => false,
                invoke: () => { throw new Error("inactive replacement must not run"); },
            }));
        }),
        hook("B", battle => { seen.push("B"); return battle; }),
        hook("C", battle => { seen.push("old C"); return battle; }),
        hook("D", battle => { seen.push("D"); return battle; }),
    ]);
    damage(state);
    assert.deepEqual(seen, ["A", "D"]);
});

test("received dispatch defers a newly registered ID until a later dispatch", () => {
    const seen = [];
    const added = hook("C", battle => { seen.push("C"); return battle; });
    let state = fixture([
        hook("A", battle => { seen.push("A"); return change(battle, vitality => setHook(vitality, added)); }),
        hook("B", battle => { seen.push("B"); return battle; }),
    ]);
    state = damage(state);
    assert.deepEqual(seen, ["A", "B"]);
    state = damage(state);
    assert.deepEqual(seen, ["A", "B", "A", "B", "C"]);
});

test("nested received dispatch independently selects current IDs", () => {
    const seen = [];
    const added = hook("C", (battle, _self, event) => { seen.push(["C", event.pending.amount]); return battle; });
    const state = fixture([
        hook("A", (battle, _self, event) => {
            seen.push(["A", event.pending.amount]);
            if (event.pending.amount !== 1) return battle;
            battle = change(battle, vitality => setHook(vitality, added));
            return damage(battle, 2);
        }),
        hook("B", (battle, _self, event) => { seen.push(["B", event.pending.amount]); return battle; }),
    ]);
    const settled = damage(state);
    assert.deepEqual(seen, [["A", 1], ["A", 2], ["B", 2], ["C", 2], ["B", 1]]);
    assert.equal(getUnit(settled, 0).vitality.hp, 97);
    assert.equal(getUnit(state, 0).vitality.hp, 100);
});
