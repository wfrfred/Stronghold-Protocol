import assert from "node:assert/strict";
import { test } from "node:test";
import {
    unit as createUnit, workFor, attach, request, parameters, damageEffect, healingEffect, setSelf,
} from "../helpers/vitality.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../dist/core/tactical/battle/damage/apply.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";

const unit = (id) => createUnit(id, { hp: 200, maxHp: 1000 });
const damageRequest = (power = 40) => request(power, { parameters: parameters(power, "TRUE") });
const settle = (battle, input) => applyDamage(input, calculateDamage(battle, input));
const healingRequest = (power = 40) => ({ sourceUnitId: 1, targetUnitId: 2, power, ignoreHealFree: true, tick: 1 });

test("settlement invariants: invalid final damage preserves its input despite preceding nested healing", () => {
    for (const invalid of [-1, NaN, Infinity]) {
        let malformed = true;
        let completed = 0;
        const content = damageEffect("invalid-damage", { uses: 0 }, [
            { stage: "receiving", invoke(state, context, self, pending) {
                state = setSelf(state, context, self, current => ({ ...current, uses: current.uses + 1 }));
                state = resolveHealing(state, healingRequest(10)).state;
                return { state, value: { ...pending, amount: malformed ? invalid : 30 } };
            } },
            { stage: "completed", invoke(state) { completed += 1; return { state, value: undefined }; } },
        ]);
        const battle = workFor(unit(1), attach(unit(2), content));
        assert.throws(() => settle(battle, damageRequest()), RangeError);
        assert.equal(getUnit(battle, 2).vitality.hp, 200);
        assert.equal(getUnit(battle, 2).effects.values()[0].data.uses, 0);
        assert.equal(completed, 0);
        malformed = false;
        const valid = settle(battle, damageRequest());
        assert.equal(getUnit(valid.state, 2).vitality.hp, 180);
        assert.equal(getUnit(valid.state, 2).effects.values()[0].data.uses, 1);
        assert.equal(valid.value.application.hpLoss, 30);
        assert.equal(completed, 1);
    }
});

test("settlement invariants: invalid final healing preserves its input despite preceding synchronous damage", () => {
    for (const invalid of [-1, NaN, Infinity]) {
        let malformed = true;
        let reactions = 0;
        const content = healingEffect("invalid-healing", { uses: 0 }, [
            { stage: "reception", invoke(state, context, self, pending) {
                state = setSelf(state, context, self, current => ({ ...current, uses: current.uses + 1 }));
                state = settle(state, damageRequest(10)).state;
                return { state, value: { ...pending, amount: malformed ? invalid : 30 } };
            } },
            { stage: "reaction", invoke(state) { reactions += 1; return { state, value: {} }; } },
        ]);
        const battle = workFor(unit(1), attach(unit(2), content));
        assert.throws(() => resolveHealing(battle, healingRequest()), RangeError);
        assert.equal(getUnit(battle, 2).vitality.hp, 200);
        assert.equal(getUnit(battle, 2).effects.values()[0].data.uses, 0);
        assert.equal(reactions, 0);
        malformed = false;
        const valid = resolveHealing(battle, healingRequest());
        assert.equal(getUnit(valid.state, 2).vitality.hp, 220);
        assert.equal(getUnit(valid.state, 2).effects.values()[0].data.uses, 1);
        assert.equal(valid.value.amount, 30);
        assert.equal(reactions, 1);
    }
});

test("settlement invariants: each completed damage phase rejects nonfinite values before later phases", () => {
    for (const stage of ["sourceFormula", "output", "receiving"]) {
        for (const invalid of [NaN, Infinity]) {
            let completed = 0;
            let repaired = false;
            const bad = damageEffect("nonfinite-report", {}, [
                { stage, priority: 100, invoke(state, _context, _self, value) {
                    return { state, value: stage === "sourceFormula"
                        ? { ...value, attack: { ...value.attack, power: invalid } }
                        : stage === "output" ? invalid
                        : { ...value, amount: invalid, cancellation: { reason: "BLOCKED" } } };
                } },
                { stage: "completed", invoke(state) { completed += 1; return { state, value: undefined }; } },
            ]);
            const repair = damageEffect("repair-after-output", {}, [
                { stage: "receiving", invoke(state, _context, _self, pending) {
                    repaired = true;
                    return { state, value: { ...pending, amount: 0 } };
                } },
            ]);
            const battle = stage === "receiving" ? workFor(unit(1), attach(unit(2), bad))
                : workFor(attach(unit(1), bad), attach(unit(2), repair));
            assert.throws(() => settle(battle, damageRequest()), RangeError);
            assert.equal(getUnit(battle, 2).vitality.hp, 200);
            assert.deepEqual(battle.events, []);
            assert.equal(completed, 0);
            assert.equal(repaired, false);
        }
    }
});

test("settlement invariants: signed intermediate receiving modifiers can resolve to valid final amounts", () => {
    const reception = (factory, id, stage, amount, priority) => factory(id, {}, [
        { stage, priority, invoke: (state, _context, _self, pending) => ({ state, value: { ...pending, amount } }) },
    ]);
    let target = attach(unit(2), reception(damageEffect, "signed-damage", "receiving", -20, 100));
    target = attach(target, reception(damageEffect, "restored-damage", "receiving", 30, 0));
    target = attach(target, reception(healingEffect, "signed-healing", "reception", -20, 100));
    target = attach(target, reception(healingEffect, "restored-healing", "reception", 30, 0));
    const damaged = settle(workFor(unit(1), target), damageRequest());
    const healed = resolveHealing(workFor(unit(1), target), healingRequest());
    assert.equal(damaged.value.received.amount, 30);
    assert.equal(getUnit(damaged.state, 2).vitality.hp, 170);
    assert.equal(healed.value.amount, 30);
    assert.equal(getUnit(healed.state, 2).vitality.hp, 230);
});

test("settlement invariants: negative output cannot cross the Calculate boundary", () => {
    const output = damageEffect("negative-output", {}, [{ stage: "output", invoke: state => ({ state, value: -40 }) }]);
    const battle = workFor(attach(unit(1), output), unit(2));
    assert.throws(() => calculateDamage(battle, damageRequest()), RangeError);
    assert.equal(getUnit(battle, 2).vitality.hp, 200);
});

test("settlement invariants: initial zero damage is rejected while zero and negative source healing remain normalized", () => {
    let battle = workFor(unit(1), unit(2));
    const damaged = settle(battle, damageRequest(0));
    battle = damaged.state;
    const healed = resolveHealing(battle, healingRequest(0));
    battle = healed.state;
    const normalized = resolveHealing(battle, healingRequest(-10));
    battle = normalized.state;
    assert.deepEqual(damaged.value, { kind: "REJECTED" });
    assert.equal(healed.value.amount, 0);
    assert.equal(normalized.value.amount, 0);
    assert.equal(getUnit(battle, 2).vitality.hp, 200);
    for (const invalid of [NaN, Infinity]) assert.throws(() => resolveHealing(battle, healingRequest(invalid)), RangeError);
});

test("settlement invariants: cancelled healing rejects a nonfinite final hook amount", () => {
    const content = healingEffect("invalid-cancelled-healing", {}, [{
        stage: "reception", invoke: (state, _context, _self, pending) => ({ state, value: { ...pending, amount: NaN, cancellation: { reason: "BLOCKED" } } }),
    }]);
    const battle = workFor(unit(1), attach(unit(2), content));
    assert.throws(() => resolveHealing(battle, healingRequest()), RangeError);
    assert.equal(getUnit(battle, 2).vitality.hp, 200);
    assert.deepEqual(battle.events, []);
});
