import assert from "node:assert/strict";
import { test } from "node:test";
import {
    unit as createUnit, workFor, attach, request, parameters, damageEffect, healingEffect, setSelf,
} from "../helpers/vitality.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../dist/core/tactical/battle/damage/apply.js";
import { calculateHealing } from "../../dist/core/tactical/battle/healing/calculate.js";
import { applyHealing } from "../../dist/core/tactical/battle/healing/apply.js";

const unit = (id) => createUnit(id, { hp: 200, maxHp: 1000 });
const damageRequest = (power = 40) => request(power, { parameters: parameters(power, "TRUE") });
const settle = (battle, input) => applyDamage(input, calculateDamage(battle, input));
const healingRequest = (power = 40) => ({ source: { id: 1 }, target: { id: 2 }, parameters: { power, multiplier: 1 } });
const heal = (battle, input) => applyHealing(input, calculateHealing(battle, input));

test("settlement invariants: invalid final damage preserves its input despite preceding nested healing", () => {
    for (const invalid of [-1, NaN, Infinity]) {
        let malformed = true;
        let completed = 0;
        const content = damageEffect("invalid-damage", { uses: 0 }, [
            { stage: "receiving", invoke(state, context, self, pending) {
                state = setSelf(state, context, self, current => ({ ...current, uses: current.uses + 1 }));
                state = heal(state, healingRequest(10)).state;
                return { state, value: { ...pending, amount: malformed ? invalid : 30 } };
            } },
            { stage: "completed", invoke(state) { completed += 1; return { state, value: undefined }; } },
        ]);
        const battle = workFor(unit(1), attach(unit(2), content));
        assert.throws(() => settle(battle, damageRequest()), RangeError);
        assert.equal(getUnit(battle, 2).vitality.hp, 200);
        assert.equal(getUnit(battle, 2).effects.values().toArray()[0].data.uses, 0);
        assert.equal(completed, 0);
        malformed = false;
        const valid = settle(battle, damageRequest());
        assert.equal(getUnit(valid.state, 2).vitality.hp, 180);
        assert.equal(getUnit(valid.state, 2).effects.values().toArray()[0].data.uses, 1);
        assert.equal(valid.value.application.hpLoss, 30);
        assert.equal(completed, 1);
    }
});

test("settlement invariants: invalid final healing preserves its input despite preceding synchronous damage", () => {
    for (const invalid of [-1, NaN, Infinity]) {
        let malformed = true;
        let reactions = 0;
        const content = healingEffect("invalid-healing", { uses: 0 }, [
            { stage: "receiving", invoke(state, context, self, pending) {
                state = setSelf(state, context, self, current => ({ ...current, uses: current.uses + 1 }));
                state = settle(state, damageRequest(10)).state;
                return { state, value: { ...pending, amount: malformed ? invalid : 30 } };
            } },
            { stage: "completed", invoke(state) { reactions += 1; return { state, value: undefined }; } },
        ]);
        const battle = workFor(unit(1), attach(unit(2), content));
        assert.throws(() => heal(battle, healingRequest()), RangeError);
        assert.equal(getUnit(battle, 2).vitality.hp, 200);
        assert.equal(getUnit(battle, 2).effects.values().toArray()[0].data.uses, 0);
        assert.equal(reactions, 0);
        malformed = false;
        const valid = heal(battle, healingRequest());
        assert.equal(getUnit(valid.state, 2).vitality.hp, 220);
        assert.equal(getUnit(valid.state, 2).effects.values().toArray()[0].data.uses, 1);
        assert.equal(valid.value.application.hpGain, 30);
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
    target = attach(target, reception(healingEffect, "signed-healing", "receiving", -20, 100));
    target = attach(target, reception(healingEffect, "restored-healing", "receiving", 30, 0));
    const damaged = settle(workFor(unit(1), target), damageRequest());
    const healed = heal(workFor(unit(1), target), healingRequest());
    assert.equal(damaged.value.received.amount, 30);
    assert.equal(getUnit(damaged.state, 2).vitality.hp, 170);
    assert.equal(healed.value.received.amount, 30);
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
    const healed = heal(battle, healingRequest(0));
    battle = healed.state;
    const normalized = heal(battle, healingRequest(-10));
    battle = normalized.state;
    assert.deepEqual(damaged.value, { kind: "REJECTED" });
    assert.equal(healed.value.application.hpGain, 0);
    assert.equal(normalized.value.application.hpGain, 0);
    assert.equal(getUnit(battle, 2).vitality.hp, 200);
    for (const invalid of [NaN, Infinity]) assert.throws(() => heal(battle, healingRequest(invalid)), RangeError);
});

test("settlement invariants: cancelled healing rejects a nonfinite final hook amount", () => {
    const content = healingEffect("invalid-cancelled-healing", {}, [{
        stage: "receiving", invoke: (state, _context, _self, pending) => ({ state, value: { ...pending, amount: NaN, cancellation: { reason: "BLOCKED" } } }),
    }]);
    const battle = workFor(unit(1), attach(unit(2), content));
    assert.throws(() => heal(battle, healingRequest()), RangeError);
    assert.equal(getUnit(battle, 2).vitality.hp, 200);
    assert.deepEqual(battle.events, []);
});

test("settlement invariants: healing rejects invalid completed Formula and Output values before Receiving", () => {
    for (const stage of ["sourceFormula", "output"]) {
        for (const invalid of [NaN, Infinity]) {
            let receiving = 0;
            let completed = 0;
            const source = healingEffect("bad-healing", {}, [{
                stage, invoke: (state, _context, _self, value) => ({
                    state, value: stage === "sourceFormula" ? { ...value, power: invalid } : invalid,
                }),
            }]);
            const target = healingEffect("observe-healing", {}, [
                { stage: "receiving", invoke(state, _context, _self, pending) { receiving += 1; return { state, value: pending }; } },
                { stage: "completed", invoke(state) { completed += 1; return { state, value: undefined }; } },
            ]);
            const battle = workFor(attach(unit(1), source), attach(unit(2), target));
            assert.throws(() => heal(battle, healingRequest()), RangeError);
            assert.equal(receiving, 0);
            assert.equal(completed, 0);
            assert.equal(getUnit(battle, 2).vitality.hp, 200);
            assert.deepEqual(battle.events, []);
        }
    }
    const source = healingEffect("negative-healing-output", {}, [{ stage: "output", invoke: state => ({ state, value: -1 }) }]);
    assert.throws(() => heal(workFor(attach(unit(1), source), unit(2)), healingRequest()), RangeError);
});
