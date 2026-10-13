import assert from "node:assert/strict";
import { test } from "node:test";
import {
    unit as createUnit,
    workFor,
    attach,
    request,
    damageEffect,
    healingEffect,
    setSelf,
} from "../helpers/vitality.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import {
    resolveDamage,
} from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import {
    resolveHealing,
} from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";

const unit = (id, flags = []) => createUnit(id, { hp: 200, maxHp: 1000, flags });
const damageRequest = (power = 40) => request(power, { damageType: "TRUE", tick: 1 });
const healingRequest = (power = 40) => ({
    sourceUnitId: 1,
    targetUnitId: 2,
    power,
    ignoreHealFree: true,
    tick: 1,
});

test("settlement invariants: invalid final damage preserves its input despite preceding nested healing", () => {
    for (const invalid of [-1, NaN, Infinity]) {
        const resources = new CombatResources();
        let malformed = true;
        let reactions = 0;
        const content = damageEffect("invalid-damage", { uses: 0 }, [
            {
                stage: "reception",
                invoke(state, context, self, pending) {
                    state = setSelf(state, context, self, (current) => ({
                        ...current,
                        uses: current.uses + 1,
                    }));
                    state = resolveHealing(state, healingRequest(10), context.call).state;
                    return {
                        state,
                        value: { value: { ...pending, amount: malformed ? invalid : 30 } },
                    };
                },
            },
            {
                stage: "reaction",
                invoke(state) {
                    reactions += 1;

                    return { state, value: {} };
                },
            },
        ]);
        let battle = workFor(unit(1), attach(unit(2), content));
        assert.throws(() => resolveDamage(battle, damageRequest(), resources), RangeError);
        assert.equal(getUnit(battle, 2).vitality.hp, 200);
        assert.equal(getUnit(battle, 2).effects.values()[0].data.uses, 0);
        assert.equal(getUnit(battle, 2).vitality.hp, 200);
        assert.equal(reactions, 0);
        malformed = false;
        let valid = battle;
        const reportSettlement = resolveDamage(valid, damageRequest(), resources);
        valid = reportSettlement.state;
        const report = reportSettlement.value;
        assert.equal(getUnit(valid, 2).vitality.hp, 180);
        assert.equal(getUnit(valid, 2).effects.values()[0].data.uses, 1);
        assert.equal(report.hpLoss, 30);
        assert.equal(reactions, 1);
    }
});

test("settlement invariants: invalid final healing preserves its input despite preceding synchronous damage", () => {
    for (const invalid of [-1, NaN, Infinity]) {
        const resources = new CombatResources();
        let malformed = true;
        let reactions = 0;
        const content = healingEffect("invalid-healing", { uses: 0 }, [
            {
                stage: "reception",
                invoke(state, context, self, pending) {
                    state = setSelf(state, context, self, (current) => ({
                        ...current,
                        uses: current.uses + 1,
                    }));
                    state = resolveDamage(state, damageRequest(10), resources, context.call).state;
                    return {
                        state,
                        value: { value: { ...pending, amount: malformed ? invalid : 30 } },
                    };
                },
            },
            {
                stage: "reaction",
                invoke(state) {
                    reactions += 1;

                    return { state, value: {} };
                },
            },
        ]);
        let battle = workFor(unit(1), attach(unit(2), content));
        assert.throws(() => resolveHealing(battle, healingRequest()), RangeError);
        assert.equal(getUnit(battle, 2).vitality.hp, 200);
        assert.equal(getUnit(battle, 2).effects.values()[0].data.uses, 0);
        assert.equal(reactions, 0);
        malformed = false;
        let valid = battle;
        const reportSettlement = resolveHealing(valid, healingRequest());
        valid = reportSettlement.state;
        const report = reportSettlement.value;
        assert.equal(getUnit(valid, 2).vitality.hp, 220);
        assert.equal(getUnit(valid, 2).effects.values()[0].data.uses, 1);
        assert.equal(report.amount, 30);
        assert.equal(reactions, 1);
    }
});

test("settlement invariants: cancelled damage cannot publish nonfinite formula or output values", () => {
    for (const stage of ["sourceFormula", "output", "reception"]) {
        for (const invalid of [NaN, Infinity]) {
            const resources = new CombatResources();
            let reactions = 0;
            let repaired = false;
            const bad = damageEffect("nonfinite-report", {}, [
                {
                    stage,
                    priority: 100,
                    invoke(state, _context, _self, value) {
                        return {
                            state,
                            value: {
                                value:
                                    stage === "sourceFormula"
                                        ? { ...value, power: invalid }
                                        : {
                                              ...value,
                                              amount: invalid,
                                              cancellation: {
                                                  stage: "RECEPTION",
                                                  reason: "BLOCKED",
                                              },
                                          },
                            },
                        };
                    },
                },
                {
                    stage: "reaction",
                    invoke(state) {
                        reactions += 1;

                        return { state, value: {} };
                    },
                },
            ]);
            const repair = damageEffect("repair-after-output", {}, [
                {
                    stage: "reception",
                    invoke(state, _context, _self, pending) {
                        repaired = true;
                        return { state, value: { value: { ...pending, amount: 0 } } };
                    },
                },
            ]);
            const battle =
                stage === "reception"
                    ? workFor(unit(1), attach(unit(2), bad))
                    : workFor(attach(unit(1), bad), attach(unit(2), repair));
            assert.throws(() => resolveDamage(battle, damageRequest(), resources), RangeError);
            assert.equal(getUnit(battle, 2).vitality.hp, 200);
            assert.deepEqual(battle.events, []);
            assert.equal(reactions, 0);
            assert.equal(repaired, false);
        }
    }
});

test("settlement invariants: signed intermediate modifiers can resolve to valid final amounts", () => {
    const resources = new CombatResources();
    const output = damageEffect("signed-output", {}, [
        {
            stage: "output",
            invoke(state, _context, _self, pending) {
                return { state, value: { value: { ...pending, amount: -40 } } };
            },
        },
    ]);
    const reception = (factory, id, amount, priority) =>
        factory(id, {}, [
            {
                stage: "reception",
                priority,
                invoke(state, _context, _self, pending) {
                    return { state, value: { value: { ...pending, amount } } };
                },
            },
        ]);
    const source = attach(unit(1), output);
    let target = attach(unit(2), reception(damageEffect, "signed-damage", -20, 100));
    target = attach(target, reception(damageEffect, "restored-damage", 30, 0));
    target = attach(target, reception(healingEffect, "signed-healing", -20, 100));
    target = attach(target, reception(healingEffect, "restored-healing", 30, 0));
    let damagedBattle = workFor(source, target);
    const damageSettlement = resolveDamage(damagedBattle, damageRequest(), resources);
    damagedBattle = damageSettlement.state;
    const damage = damageSettlement.value;
    let healedBattle = workFor(source, target);
    const healingSettlement = resolveHealing(healedBattle, healingRequest());
    healedBattle = healingSettlement.state;
    const healing = healingSettlement.value;
    assert.equal(damage.outputDamage, -40);
    assert.equal(damage.hpDamage, 30);
    assert.equal(getUnit(damagedBattle, 2).vitality.hp, 170);
    assert.equal(healing.amount, 30);
    assert.equal(getUnit(healedBattle, 2).vitality.hp, 230);
});

test("settlement invariants: zero amounts remain valid and negative source healing is normalized", () => {
    const resources = new CombatResources();
    let battle = workFor(unit(1), unit(2));
    const damageSettlement = resolveDamage(battle, damageRequest(0), resources);
    battle = damageSettlement.state;
    const damage = damageSettlement.value;
    const healingSettlement = resolveHealing(battle, healingRequest(0));
    battle = healingSettlement.state;
    const healing = healingSettlement.value;
    const normalizedSettlement = resolveHealing(battle, healingRequest(-10));
    battle = normalizedSettlement.state;
    const normalized = normalizedSettlement.value;
    assert.equal(damage.hpDamage, 0);
    assert.equal(damage.hpLoss, 0);
    assert.equal(healing.amount, 0);
    assert.equal(normalized.amount, 0);
    assert.equal(getUnit(battle, 2).vitality.hp, 200);
    for (const invalid of [NaN, Infinity])
        assert.throws(() => resolveHealing(battle, healingRequest(invalid)), RangeError);
});

test("settlement invariants: cancelled healing rejects a nonfinite final hook amount", () => {
    const content = healingEffect("invalid-cancelled-healing", {}, [
        {
            stage: "reception",
            invoke(state, _context, _self, pending) {
                return {
                    state,
                    value: {
                        value: { ...pending, amount: NaN, cancellation: { reason: "BLOCKED" } },
                    },
                };
            },
        },
    ]);
    let battle = workFor(unit(1), attach(unit(2), content));
    assert.throws(() => resolveHealing(battle, healingRequest()), RangeError);
    assert.equal(getUnit(battle, 2).vitality.hp, 200);
    assert.deepEqual(battle.events, []);
});
