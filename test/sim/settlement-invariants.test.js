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
import { createBattleState, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import {
    damageUnit,
    resolveDamage,
} from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import {
    healUnit,
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

test("settlement invariants: invalid final damage leaves published state intact and its draft can be discarded", () => {
    for (const invalid of [-1, NaN, Infinity]) {
        const resources = new CombatResources();
        let malformed = true;
        let reactions = 0;
        const content = damageEffect("invalid-damage", { uses: 0 }, [
            {
                stage: "reception",
                invoke(context, self, pending) {
                    setSelf(context, self, (state) => ({ ...state, uses: state.uses + 1 }));
                    context.operations.heal(healingRequest(10));
                    return { value: { ...pending, amount: malformed ? invalid : 30 } };
                },
            },
            {
                stage: "reaction",
                invoke() {
                    reactions += 1;
                },
            },
        ]);
        const battle = workFor(unit(1), attach(unit(2), content));
        assert.throws(() => resolveDamage(battle, damageRequest(), resources), RangeError);
        assert.equal(battle.battlefield.snapshot("state").getUnit(2).vitality.hp, 200);
        assert.equal(
            battle.battlefield.snapshot("state").getUnit(2).effects.instances[0].state.uses,
            0,
        );
        battle.battlefield.drop();
        assert.equal(getUnit(battle, 2).vitality.hp, 200);
        assert.equal(reactions, 0);
        malformed = false;
        const valid = createBattleState(battle.battlefield);
        const report = resolveDamage(valid, damageRequest(), resources);
        assert.equal(getUnit(valid, 2).vitality.hp, 180);
        assert.equal(getUnit(valid, 2).effects.instances[0].state.uses, 1);
        assert.equal(report.hpLoss, 30);
        assert.equal(reactions, 1);
    }
});

test("settlement invariants: invalid final healing rejects after synchronous damage without publishing", () => {
    for (const invalid of [-1, NaN, Infinity]) {
        const resources = new CombatResources();
        let malformed = true;
        let reactions = 0;
        const content = healingEffect("invalid-healing", { uses: 0 }, [
            {
                stage: "reception",
                invoke(context, self, pending) {
                    setSelf(context, self, (state) => ({ ...state, uses: state.uses + 1 }));
                    context.operations.damage(damageRequest(10));
                    return { value: { ...pending, amount: malformed ? invalid : 30 } };
                },
            },
            {
                stage: "reaction",
                invoke() {
                    reactions += 1;
                },
            },
        ]);
        const battle = workFor(unit(1), attach(unit(2), content));
        assert.throws(() => resolveHealing(battle, healingRequest(), resources), RangeError);
        assert.equal(battle.battlefield.snapshot("state").getUnit(2).vitality.hp, 200);
        assert.equal(
            battle.battlefield.snapshot("state").getUnit(2).effects.instances[0].state.uses,
            0,
        );
        battle.battlefield.drop();
        assert.equal(reactions, 0);
        malformed = false;
        const valid = createBattleState(battle.battlefield);
        const report = resolveHealing(valid, healingRequest(), resources);
        assert.equal(getUnit(valid, 2).vitality.hp, 220);
        assert.equal(getUnit(valid, 2).effects.instances[0].state.uses, 1);
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
                    invoke(_context, _self, value) {
                        return {
                            value:
                                stage === "sourceFormula"
                                    ? { ...value, power: invalid }
                                    : {
                                          ...value,
                                          amount: invalid,
                                          cancellation: { stage: "RECEPTION", reason: "BLOCKED" },
                                      },
                        };
                    },
                },
                {
                    stage: "reaction",
                    invoke() {
                        reactions += 1;
                    },
                },
            ]);
            const repair = damageEffect("repair-after-output", {}, [
                {
                    stage: "reception",
                    invoke(_context, _self, pending) {
                        repaired = true;
                        return { value: { ...pending, amount: 0 } };
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
            invoke(_context, _self, pending) {
                return { value: { ...pending, amount: -40 } };
            },
        },
    ]);
    const reception = (factory, id, amount, priority) =>
        factory(id, {}, [
            {
                stage: "reception",
                priority,
                invoke(_context, _self, pending) {
                    return { value: { ...pending, amount } };
                },
            },
        ]);
    const source = attach(unit(1), output);
    let target = attach(unit(2), reception(damageEffect, "signed-damage", -20, 100));
    target = attach(target, reception(damageEffect, "restored-damage", 30, 0));
    target = attach(target, reception(healingEffect, "signed-healing", -20, 100));
    target = attach(target, reception(healingEffect, "restored-healing", 30, 0));
    const damagedBattle = workFor(source, target);
    const damage = resolveDamage(damagedBattle, damageRequest(), resources);
    const healedBattle = workFor(source, target);
    const healing = resolveHealing(healedBattle, healingRequest(), resources);
    assert.equal(damage.outputDamage, -40);
    assert.equal(damage.hpDamage, 30);
    assert.equal(getUnit(damagedBattle, 2).vitality.hp, 170);
    assert.equal(healing.amount, 30);
    assert.equal(getUnit(healedBattle, 2).vitality.hp, 230);
});

test("settlement invariants: zero amounts remain valid and negative source healing is normalized", () => {
    const resources = new CombatResources();
    const battle = workFor(unit(1), unit(2));
    const damage = resolveDamage(battle, damageRequest(0), resources);
    const healing = resolveHealing(battle, healingRequest(0), resources);
    const normalized = resolveHealing(battle, healingRequest(-10), resources);
    assert.equal(damage.hpDamage, 0);
    assert.equal(damage.hpLoss, 0);
    assert.equal(healing.amount, 0);
    assert.equal(normalized.amount, 0);
    assert.equal(getUnit(battle, 2).vitality.hp, 200);
    assert.equal(damageUnit(unit(2), 0, "TRUE").amount, 0);
    assert.equal(healUnit(unit(2), 0).amount, 0);
    for (const invalid of [NaN, Infinity])
        assert.throws(() => resolveHealing(battle, healingRequest(invalid), resources), RangeError);
});

test("settlement invariants: cancelled healing rejects a nonfinite final hook amount", () => {
    const content = healingEffect("invalid-cancelled-healing", {}, [
        {
            stage: "reception",
            invoke(_context, _self, pending) {
                return { value: { ...pending, amount: NaN, cancellation: { reason: "BLOCKED" } } };
            },
        },
    ]);
    const battle = workFor(unit(1), attach(unit(2), content));
    assert.throws(
        () => resolveHealing(battle, healingRequest(), new CombatResources()),
        RangeError,
    );
    assert.equal(getUnit(battle, 2).vitality.hp, 200);
    assert.deepEqual(battle.events, []);
});

test("settlement invariants: public vitality transitions validate final amounts", () => {
    for (const target of [unit(2), unit(2, ["INVINCIBLE", "HEAL_FREE"])]) {
        for (const invalid of [-1, NaN, Infinity, -Infinity]) {
            assert.throws(() => damageUnit(target, invalid, "TRUE"), RangeError);
            assert.throws(() => healUnit(target, invalid), RangeError);
            assert.throws(() => healUnit(target, 10, true, invalid), RangeError);
            assert.equal(target.vitality.hp, 200);
        }
    }
});
