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
    id, stage, priority, accepts: enabled, invoke,
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
                return { state, value: input };
            }, -10, (battle, context) => {
                seen.push(["new enabled", getUnit(battle, context.host.id).vitality.hp]);
                return enabled;
            });
            const original = fixture(domain, [
                hook("A", (state, _context, input) => {
                    seen.push("A");
                    state = change(state, vitality => registry.setHook({ ...vitality, hp: 60 }, replacement));
                    return { state, value: input };
                }, 10),
                hook("B", (state, _context, input) => {
                    seen.push("old B");
                    return { state, value: input };
                }, 1, () => { seen.push("old enabled"); return !enabled; }),
                hook("C", (state, _context, input) => {
                    seen.push("C");
                    return { state, value: input };
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
                return { state: change(state, vitality => registry.setHook(vitality, replacement)), value: input };
            }, 10),
            hook("B", () => assert.fail("the replaced program cannot run"), 1),
            hook("C", (state, _context, input) => {
                seen.push("C");
                return { state, value: input };
            }),
        ]);
        settle(domain, original);
        assert.deepEqual(seen, ["A", "C"]);
    });
}

for (const domain of ["damage", "healing"]) {
    const registry = domain === "damage" ? damage : healing;

    test(`${domain} reactions retain one report context while observing the latest battle`, () => {
        const contexts = [];
        const observed = [];
        const initial = fixture(domain, [
            hook("first", (battle, context, current) => {
                contexts.push(context);
                observed.push([context.report, getUnit(battle, context.host.id).vitality.hp]);
                return { state: change(battle, vitality => ({ ...vitality, hp: 70 })), value: current };
            }, 10, () => true, "reaction"),
            hook("second", (battle, context, current) => {
                contexts.push(context);
                observed.push([context.report, getUnit(battle, context.host.id).vitality.hp]);
                return { state: battle, value: current };
            }, 0, () => true, "reaction"),
        ]);
        const settled = settle(domain, initial);
        assert.equal(contexts[0], contexts[1]);
        assert.equal(observed[0][0], observed[1][0]);
        assert.equal(domain === "damage" ? observed[1][0].hpLoss : observed[1][0].amount, 1);
        assert.deepEqual(observed.map(([, hp]) => hp), [domain === "damage" ? 49 : 51, 70]);
        assert.equal(getUnit(settled, 0).vitality.hp, 70);
        assert.equal(getUnit(initial, 0).vitality.hp, 50);
    });

    test(`${domain} stopping a stage retains its state and value and still notifies reactions`, () => {
        const seen = [];
        const initial = fixture(domain, [
            hook("stop", (battle, _context, current) => ({
                state: change(battle, vitality => ({ ...vitality, hp: 60 })),
                value: { ...current, amount: 0, stopDispatch: true },
            })),
            hook("skipped", () => assert.fail("a stopped stage cannot invoke its next candidate")),
            hook("reaction", (battle, context, current) => {
                seen.push(domain === "damage" ? context.report.hpLoss : context.report.amount);
                return { state: battle, value: current };
            }, 0, () => true, "reaction"),
        ]);
        const settled = settle(domain, initial);
        assert.deepEqual(seen, [0]);
        assert.equal(getUnit(settled, 0).vitality.hp, 60);
        assert.equal(getUnit(initial, 0).vitality.hp, 50);
    });
}

test("damage output stop stays local and does not enter the received fact", () => {
    const seen = [];
    const initial = fixture("damage", [
        hook("output", (battle, _context, current) => ({
            state: battle,
            value: { ...current, amount: 4, stopDispatch: true },
        }), 10, () => true, "output"),
        hook("output-skipped", () => assert.fail("the output stage already stopped"), 0, () => true, "output"),
        {
            id: "received", stage: "received",
            invoke(battle, { event }) {
                assert.deepEqual(Object.keys(event.pending).sort(), ["amount", "cancellation", "consumptions"]);
                assert.equal(event.pending.amount, 4);
                seen.push("received");
                return { state: battle, value: undefined };
            },
        },
        hook("reception", (battle, _context, current) => {
            seen.push("reception");
            return { state: battle, value: { ...current, amount: current.amount - 1 } };
        }),
    ]);
    const result = resolveDamage(initial, {
        sourceUnitId: 0, targetUnitId: 0, damageType: "TRUE", operands: createDamageOperands(1), tick: initial.tick,
    });
    assert.deepEqual(seen, ["received", "reception"]);
    assert.equal(result.value.outputDamage, 4);
    assert.equal(result.value.hpLoss, 3);
});

test("formula stopping does not carry its control into the next formula stage", () => {
    const seen = [];
    const operands = createDamageOperands(1);
    const initial = fixture("damage", [
        hook("source", (battle, _context, current) => ({
            state: battle,
            value: { ...current, power: 7, stopDispatch: true },
        }), 10, () => true, "sourceFormula"),
        hook("source-skipped", () => assert.fail("the source formula already stopped"), 0, () => true, "sourceFormula"),
        hook("target", (battle, _context, current) => {
            assert.equal(current.stopDispatch, false);
            assert.equal(current.power, 7);
            seen.push("target");
            return { state: battle, value: current };
        }, 0, () => true, "targetFormula"),
    ]);
    const result = resolveDamage(initial, {
        sourceUnitId: 0, targetUnitId: 0, damageType: "TRUE", operands, tick: initial.tick,
    });
    assert.deepEqual(seen, ["target"]);
    assert.equal(result.value.formulaDamage, 7);
    assert.deepEqual(result.value.request.operands, operands);
    assert.equal("stopDispatch" in result.value.request.operands, false);
});

for (const domain of ["damage", "healing"]) {
    test(`${domain} output stopping does not stop the reception stage`, () => {
        const initial = fixture(domain, [
            hook("output", (battle, _context, current) => ({
                state: battle,
                value: { ...current, amount: 4, stopDispatch: true },
            }), 0, () => true, "output"),
            hook("reception", (battle, _context, current) => {
                assert.equal(current.stopDispatch, false);
                return { state: battle, value: { ...current, amount: 2 } };
            }),
        ]);
        const result = domain === "damage"
            ? resolveDamage(initial, { sourceUnitId: 0, targetUnitId: 0, damageType: "TRUE", operands: createDamageOperands(1), tick: initial.tick })
            : resolveHealing(initial, { sourceUnitId: 0, targetUnitId: 0, power: 1, tick: initial.tick });
        assert.equal(domain === "damage" ? result.value.hpLoss : result.value.amount, 2);
    });
}
