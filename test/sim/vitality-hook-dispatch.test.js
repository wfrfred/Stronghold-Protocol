import assert from "node:assert/strict";
import { test } from "node:test";
import * as damage from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import * as healing from "../../dist/core/tactical/unit/capability/vitality/healing/hook.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { initialize } from "../helpers/unit.js";
import { effectFixtureWork } from "../helpers/effects.js";

const hook = (id, invoke, priority = 0, enabled = () => true, stage = "reception") => ({
    id, stage, priority, enabled, invoke,
});
const change = (battle, transform) => {
    const unit = getUnit(battle, 0);
    return updateUnit(battle, { ...unit, vitality: transform(unit.vitality) });
};
function fixture(domain, hooks) {
    const unit = initialize({ id: 0, position: [0, 0], definition: { id: "receiver", vitality: { maxHp: 100 } } });
    return change(effectFixtureWork(unit), vitality => ({ ...vitality, hp: 50, [`${domain}Hooks`]: hooks }));
}
const settle = (domain, battle) => domain === "damage"
    ? resolveDamage(battle, { sourceUnitId: null, targetUnitId: 0, damageType: "TRUE", operands: createDamageOperands(1), tick: battle.tick }).state
    : resolveHealing(battle, { sourceUnitId: null, targetUnitId: 0, power: 1, tick: battle.tick }).state;

for (const [domain, registry] of [["damage", damage], ["healing", healing]]) {
    for (const enabled of [true, false]) {
        test(`${domain} dispatch reads replacement enabled=${enabled} without reordering selected priorities`, () => {
            const seen = [];
            const replacement = hook("B", (state, _context, input) => {
                seen.push("new B");
                return { state, value: { value: input } };
            }, -10, context => {
                seen.push(["new enabled", context.unit.vitality.hp]);
                return enabled;
            });
            const original = fixture(domain, [
                hook("A", (state, _context, input) => {
                    seen.push("A");
                    state = change(state, vitality => registry.setHook({ ...vitality, hp: 60 }, replacement));
                    return { state, value: { value: input } };
                }, 10),
                hook("B", (state, _context, input) => {
                    seen.push("old B");
                    return { state, value: { value: input } };
                }, 1, () => { seen.push("old enabled"); return !enabled; }),
                hook("C", (state, _context, input) => {
                    seen.push("C");
                    return { state, value: { value: input } };
                }),
            ]);
            const settled = settle(domain, original);
            assert.deepEqual(seen, ["A", ["new enabled", 60], ...(enabled ? ["new B"] : []), "C"]);
            assert.equal(getUnit(settled, 0).vitality.hp, domain === "damage" ? 59 : 61);
            assert.equal(getUnit(original, 0).vitality.hp, 50);
        });
    }

    test(`${domain} dispatch skips a selected ID whose replacement changed stage`, () => {
        const seen = [];
        const replacement = hook("B", () => assert.fail("a replacement in another stage cannot run"), 100, () => {
            assert.fail("a replacement in another stage cannot check enabled");
        }, "output");
        const original = fixture(domain, [
            hook("A", (state, _context, input) => {
                seen.push("A");
                return { state: change(state, vitality => registry.setHook(vitality, replacement)), value: { value: input } };
            }, 10),
            hook("B", () => assert.fail("the replaced program cannot run"), 1),
            hook("C", (state, _context, input) => {
                seen.push("C");
                return { state, value: { value: input } };
            }),
        ]);
        settle(domain, original);
        assert.deepEqual(seen, ["A", "C"]);
    });
}
