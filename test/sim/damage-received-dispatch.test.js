import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../dist/core/tactical/battle/damage/apply.js";
import { setHook, removeHook } from "../../dist/core/tactical/battle/damage/hook.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { initialize } from "../helpers/unit.js";
import { effectFixtureWork } from "../helpers/effects.js";

const hook = (id, invoke, accepts = () => true) => ({ id, stage: "receivingStarted", priority: 0, accepts, invoke });
const change = (battle, transform) => {
    const unit = getUnit(battle, 0);
    return updateUnit(battle, { ...unit, vitality: transform(unit.vitality) });
};
function fixture(hooks, hp = 100) {
    const unit = initialize({ id: 0, position: [0, 0], definition: { id: "receiver", vitality: { maxHp: 100 } } });
    return change(effectFixtureWork(unit), vitality => ({ ...vitality, hp, damageHooks: hooks }));
}
const damage = (battle, power = 1) => {
    const request = {
        source: null, target: { id: 0 },
        parameters: { type: "TRUE", attack: { power, multiplier: 1, addition: 0 } },
    };
    return applyDamage(request, calculateDamage(battle, request)).state;
};

for (const enabled of [true, false]) {
    test(`receivingStarted dispatch uses a replacement's current enabled=${enabled} and program`, () => {
        const seen = [];
        const replacement = hook("B", battle => { seen.push("new B"); return { state: battle, value: undefined }; }, (battle, { request, calculated }) => {
            seen.push(["new enabled", getUnit(battle, request.target.id).vitality.hp, calculated.amount]);
            return enabled;
        });
        const state = fixture([
            hook("A", battle => {
                seen.push("A");
                battle = resolveHealing(battle, { sourceUnitId: null, targetUnitId: 0, power: 10, tick: battle.tick }).state;
                return { state: change(battle, vitality => setHook(vitality, replacement)), value: undefined };
            }),
            hook("B", battle => { seen.push("old B"); return { state: battle, value: undefined }; }, () => {
                seen.push("old enabled");
                return !enabled;
            }),
        ], 80);
        const settled = damage(state);
        assert.deepEqual(seen, ["A", ["new enabled", 90, 1], ...(enabled ? ["new B"] : [])]);
        assert.equal(getUnit(settled, 0).vitality.hp, 89);
        assert.equal(getUnit(state, 0).vitality.hp, 80);
    });
}

test("receivingStarted dispatch skips removed IDs and replacements moved to another stage", () => {
    const seen = [];
    const state = fixture([
        hook("A", battle => {
            seen.push("A");
            return { state: change(battle, vitality => setHook(removeHook(vitality, "B"), {
                id: "C", stage: "completed", priority: 0, accepts: () => false,
                invoke: () => { throw new Error("inactive replacement must not run"); },
            })), value: undefined };
        }),
        hook("B", battle => { seen.push("B"); return { state: battle, value: undefined }; }),
        hook("C", battle => { seen.push("old C"); return { state: battle, value: undefined }; }),
        hook("D", battle => { seen.push("D"); return { state: battle, value: undefined }; }),
    ]);
    damage(state);
    assert.deepEqual(seen, ["A", "D"]);
});

test("receivingStarted dispatch defers newly registered IDs until a later dispatch", () => {
    const seen = [];
    const added = hook("C", battle => { seen.push("C"); return { state: battle, value: undefined }; });
    let state = fixture([
        hook("A", battle => { seen.push("A"); return { state: change(battle, vitality => setHook(vitality, added)), value: undefined }; }),
        hook("B", battle => { seen.push("B"); return { state: battle, value: undefined }; }),
    ]);
    state = damage(state);
    assert.deepEqual(seen, ["A", "B"]);
    state = damage(state);
    assert.deepEqual(seen, ["A", "B", "A", "B", "C"]);
});

test("nested receivingStarted dispatch independently selects current IDs", () => {
    const seen = [];
    const added = hook("C", (battle, { calculated }) => { seen.push(["C", calculated.amount]); return { state: battle, value: undefined }; });
    const state = fixture([
        hook("A", (battle, { calculated }) => {
            seen.push(["A", calculated.amount]);
            if (calculated.amount !== 1) return { state: battle, value: undefined };
            battle = change(battle, vitality => setHook(vitality, added));
            return { state: damage(battle, 2), value: undefined };
        }),
        hook("B", (battle, { calculated }) => { seen.push(["B", calculated.amount]); return { state: battle, value: undefined }; }),
    ]);
    const settled = damage(state);
    assert.deepEqual(seen, [["A", 1], ["A", 2], ["B", 2], ["C", 2], ["B", 1]]);
    assert.equal(getUnit(settled, 0).vitality.hp, 97);
    assert.equal(getUnit(state, 0).vitality.hp, 100);
});
