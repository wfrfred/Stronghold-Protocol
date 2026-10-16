import assert from "node:assert/strict";
import { test } from "node:test";
import * as damage from "../../dist/core/tactical/battle/damage/hook.js";
import * as healing from "../../dist/core/tactical/unit/capability/vitality/healing/hook.js";
import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../dist/core/tactical/battle/damage/apply.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { initialize } from "../helpers/unit.js";
import { effectFixtureWork } from "../helpers/effects.js";

const hook = (id, invoke, priority = 0, accepts = () => true, stage = "reception") => ({ id, stage, priority, accepts, invoke });
const change = (battle, transform) => {
    const unit = getUnit(battle, 0);
    return updateUnit(battle, { ...unit, vitality: transform(unit.vitality) });
};
function fixture(domain, hooks) {
    const unit = initialize({ id: 0, position: [0, 0], definition: { id: "receiver", vitality: { maxHp: 100 } } });
    return change(effectFixtureWork(unit), vitality => ({ ...vitality, hp: 50, [`${domain}Hooks`]: hooks }));
}
const input = source => ({
    source, target: { id: 0 }, parameters: { type: "TRUE", attack: { power: 1, multiplier: 1, addition: 0 } },
});
const settleDamage = (battle, request = input(null)) => applyDamage(request, calculateDamage(battle, request));
const settle = (domain, battle) => domain === "damage" ? settleDamage(battle).state
    : resolveHealing(battle, { sourceUnitId: null, targetUnitId: 0, power: 1, tick: battle.tick }).state;

for (const [domain, registry] of [["damage", damage], ["healing", healing]]) {
    const stage = domain === "damage" ? "receiving" : "reception";
    for (const enabled of [true, false]) {
        test(`${domain} dispatch reads replacement enabled=${enabled} without reordering selected priorities`, () => {
            const seen = [];
            const replacement = hook("B", (state, _context, current) => { seen.push("new B"); return { state, value: current }; }, -10,
                (battle, context) => {
                    seen.push(["new enabled", getUnit(battle, domain === "damage" ? context.request.target.id : context.host.id).vitality.hp]);
                    return enabled;
                }, stage);
            const original = fixture(domain, [
                hook("A", (state, _context, current) => {
                    seen.push("A");
                    state = domain === "damage" ? resolveHealing(state, { sourceUnitId: null, targetUnitId: 0, power: 10, tick: state.tick }).state
                        : change(state, vitality => ({ ...vitality, hp: 60 }));
                    return { state: change(state, vitality => registry.setHook(vitality, replacement)), value: current };
                }, 10, () => true, stage),
                hook("B", (state, _context, current) => { seen.push("old B"); return { state, value: current }; }, 1,
                    () => { seen.push("old enabled"); return !enabled; }, stage),
                hook("C", (state, _context, current) => { seen.push("C"); return { state, value: current }; }, 0, () => true, stage),
            ]);
            const settled = settle(domain, original);
            assert.deepEqual(seen, ["A", ["new enabled", 60], ...(enabled ? ["new B"] : []), "C"]);
            assert.equal(getUnit(settled, 0).vitality.hp, domain === "damage" ? 59 : 61);
            assert.equal(getUnit(original, 0).vitality.hp, 50);
        });
    }

    test(`${domain} dispatch skips a selected ID whose replacement changed stage`, () => {
        const seen = [];
        const replacement = hook("B", () => assert.fail("a replacement in another stage cannot run"), 100,
            () => assert.fail("a replacement in another stage cannot check enabled"), "output");
        const original = fixture(domain, [
            hook("A", (state, _context, current) => {
                seen.push("A"); return { state: change(state, vitality => registry.setHook(vitality, replacement)), value: current };
            }, 10, () => true, stage),
            hook("B", () => assert.fail("the replaced program cannot run"), 1, () => true, stage),
            hook("C", (state, _context, current) => { seen.push("C"); return { state, value: current }; }, 0, () => true, stage),
        ]);
        settle(domain, original);
        assert.deepEqual(seen, ["A", "C"]);
    });
}

for (const domain of ["damage", "healing"]) {
    test(`${domain} notifications retain one result context while observing the latest battle`, () => {
        const contexts = [];
        const observed = [];
        const stage = domain === "damage" ? "completed" : "reaction";
        const initial = fixture(domain, [
            hook("first", (battle, context, current) => {
                contexts.push(context);
                observed.push([domain === "damage" ? context.outcome : context.report, getUnit(battle, 0).vitality.hp]);
                battle = domain === "damage" ? resolveHealing(battle, { sourceUnitId: null, targetUnitId: 0, power: 21, tick: battle.tick }).state
                    : change(battle, vitality => ({ ...vitality, hp: 70 }));
                return { state: battle, value: current };
            }, 10, () => true, stage),
            hook("second", (battle, context, current) => {
                contexts.push(context);
                observed.push([domain === "damage" ? context.outcome : context.report, getUnit(battle, 0).vitality.hp]);
                return { state: battle, value: current };
            }, 0, () => true, stage),
        ]);
        const settled = settle(domain, initial);
        assert.equal(contexts[0], contexts[1]);
        assert.equal(observed[0][0], observed[1][0]);
        assert.equal(domain === "damage" ? observed[1][0].application.hpLoss : observed[1][0].amount, 1);
        assert.deepEqual(observed.map(([, hp]) => hp), [domain === "damage" ? 49 : 51, 70]);
        assert.equal(getUnit(settled, 0).vitality.hp, 70);
        assert.equal(getUnit(initial, 0).vitality.hp, 50);
    });
}

test("healing stopping a stage retains its state and value and still notifies reactions", () => {
    const seen = [];
    const initial = fixture("healing", [
        hook("stop", (battle, _context, current) => ({ state: change(battle, vitality => ({ ...vitality, hp: 60 })), value: { ...current, amount: 0, stopDispatch: true } })),
        hook("skipped", () => assert.fail("a stopped stage cannot invoke its next candidate")),
        hook("reaction", (battle, context, current) => { seen.push(context.report.amount); return { state: battle, value: current }; }, 0, () => true, "reaction"),
    ]);
    const settled = settle("healing", initial);
    assert.deepEqual(seen, [0]);
    assert.equal(getUnit(settled, 0).vitality.hp, 60);
    assert.equal(getUnit(initial, 0).vitality.hp, 50);
});

test("damage output threads numeric values independently from Receiving facts", () => {
    const seen = [];
    const initial = fixture("damage", [
        hook("output", (battle, context) => {
            seen.push(["output", context.type, context.request.parameters.attack.power]);
            return { state: battle, value: 4 };
        }, 10, () => true, "output"),
        hook("output-next", (battle, _context, current) => ({ state: battle, value: current * 2 }), 0, () => true, "output"),
        hook("started", (battle, { calculated }) => {
            seen.push(["started", calculated.amount]); return { state: battle, value: undefined };
        }, 0, () => true, "receivingStarted"),
        hook("receiving", (battle, _context, current) => {
            assert.deepEqual(Object.keys(current).sort(), ["amount", "cancellation"]);
            seen.push(["receiving", current.amount]);
            return { state: battle, value: { ...current, amount: current.amount - 1 } };
        }, 0, () => true, "receiving"),
    ]);
    const result = settleDamage(initial, input({ id: 0 }));
    assert.deepEqual(seen, [["output", "TRUE", 1], ["started", 8], ["receiving", 8]]);
    assert.equal(result.value.received.amount, 7);
    assert.equal(result.value.application.hpLoss, 7);
});

test("source and target Formula Hooks thread Parameters while the original Request remains fixed", () => {
    const seen = [];
    const request = input({ id: 0 });
    const initial = fixture("damage", [
        hook("source", (battle, context, current) => {
            seen.push(["source", context === request]);
            return { state: battle, value: { ...current, attack: { ...current.attack, power: 7 } } };
        }, 10, () => true, "sourceFormula"),
        hook("source-next", (battle, context, current) => {
            seen.push(["source-next", context === request, current.attack.power]);
            return { state: battle, value: { ...current, attack: { ...current.attack, power: current.attack.power + 1 } } };
        }, 0, () => true, "sourceFormula"),
        hook("target", (battle, context, current) => {
            seen.push(["target", context === request, current.attack.power]);
            return { state: battle, value: { ...current, attack: { ...current.attack, power: current.attack.power + 2 } } };
        }, 0, () => true, "targetFormula"),
    ]);
    const result = calculateDamage(initial, request);
    assert.deepEqual(seen, [["source", true], ["source-next", true, 7], ["target", true, 8]]);
    assert.deepEqual(result.value, { type: "TRUE", amount: 10 });
    assert.equal(request.parameters.attack.power, 1);
    assert.equal(getUnit(result.state, 0).vitality.hp, 50);
});

test("healing output stopping does not stop the reception stage", () => {
    const initial = fixture("healing", [
        hook("output", (battle, _context, current) => ({ state: battle, value: { ...current, amount: 4, stopDispatch: true } }), 0, () => true, "output"),
        hook("reception", (battle, _context, current) => {
            assert.equal(current.stopDispatch, false);
            return { state: battle, value: { ...current, amount: 2 } };
        }),
    ]);
    const result = resolveHealing(initial, { sourceUnitId: 0, targetUnitId: 0, power: 1, tick: initial.tick });
    assert.equal(result.value.amount, 2);
});
