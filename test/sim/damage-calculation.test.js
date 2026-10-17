import assert from "node:assert/strict";
import { test } from "node:test";
import {
    unit, workFor, attach, request, parameters, damageEffect, setSelf, stateOf,
} from "../helpers/vitality.js";
import { createRng } from "../../dist/core/common/rng.js";
import { getUnit, transitionUnit } from "../../dist/core/tactical/battle/state.js";
import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../dist/core/tactical/battle/damage/apply.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import { setDefenseContribution } from "../../dist/core/tactical/unit/capability/defense/capability.js";
import { healing } from "../helpers/vitality.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/attribute.js";

test("damage calculation: independent candidates retain only the higher output branch before one application", () => {
    const calculation = damageEffect("branch-budget", {
        formulaBudget: 5, outputBudget: 5, formulaRolls: [], outputInputs: [],
    }, [
        { stage: "sourceFormula", invoke(state, context, self, current) {
            const cost = current.type === "ARTS" ? 2 : 1;
            const rng = createRng(state.execution.rngState);
            const roll = rng.next();
            state = setSelf(state, context, self, data => ({
                ...data,
                formulaBudget: data.formulaBudget - cost,
                formulaRolls: [...data.formulaRolls, roll],
            }));
            state = healing(state, {
                source: { id: 1 }, target: { id: 1 }, parameters: { power: cost * 10, multiplier: 1 },
            }).state;
            return {
                state: { ...state, execution: { ...state.execution, rngState: rng.state() } },
                value: current,
            };
        } },
        { stage: "output", invoke(state, context, self, amount) {
            const cost = context.type === "ARTS" ? 2 : 1;
            const rng = createRng(state.execution.rngState);
            for (let i = 0; i < cost; i++) rng.next();
            state = setSelf(state, context, self, data => ({
                ...data,
                outputBudget: data.outputBudget - cost,
                outputInputs: [...data.outputInputs, { type: context.type, amount }],
            }));
            return {
                state: { ...state, execution: { ...state.execution, rngState: rng.state() } },
                value: context.type === "ARTS" ? amount * 2 : amount,
            };
        } },
    ]);
    const reception = damageEffect("application-count", { receiving: 0, hpApplied: 0 }, [
        { stage: "receiving", invoke(state, context, self, pending) {
            return {
                state: setSelf(state, context, self, data => ({ ...data, receiving: data.receiving + 1 })),
                value: pending,
            };
        } },
        { stage: "hpApplied", invoke(state, context, self) {
            return {
                state: setSelf(state, context, self, data => ({ ...data, hpApplied: data.hpApplied + 1 })),
                value: undefined,
            };
        } },
    ]);
    const battle = workFor(
        attach(unit(1, { hp: 500, maxHp: 1000 }), calculation),
        attach(unit(2, { hp: 500, defense: 0, resistance: 10 }), reception),
    );
    const physicalRequest = request(100);
    const artsRequest = request(100, { parameters: parameters(100, "ARTS") });
    const physical = calculateDamage(battle, physicalRequest);
    const arts = calculateDamage(battle, artsRequest);

    assert.deepEqual(physical.value, { type: "PHYSICAL", amount: 100 });
    assert.deepEqual(arts.value, { type: "ARTS", amount: 180 });
    assert.deepEqual(stateOf(physical.state, 1, calculation).outputInputs, [{ type: "PHYSICAL", amount: 100 }]);
    assert.deepEqual(stateOf(arts.state, 1, calculation).outputInputs, [{ type: "ARTS", amount: 90 }]);
    assert.equal(stateOf(physical.state, 1, calculation).formulaBudget, 4);
    assert.equal(stateOf(physical.state, 1, calculation).outputBudget, 4);
    assert.equal(stateOf(arts.state, 1, calculation).formulaBudget, 3);
    assert.equal(stateOf(arts.state, 1, calculation).outputBudget, 3);
    assert.deepEqual(stateOf(physical.state, 1, calculation).formulaRolls, stateOf(arts.state, 1, calculation).formulaRolls);
    const expectedRng = createRng(battle.execution.rngState);
    expectedRng.next();
    expectedRng.next();
    assert.equal(physical.state.execution.rngState, expectedRng.state());
    expectedRng.next();
    assert.equal(arts.state.execution.rngState, expectedRng.state());
    for (const candidate of [physical, arts]) {
        assert.equal(getUnit(candidate.state, 2).vitality.hp, 500);
        assert.deepEqual(stateOf(candidate.state, 2, reception), { receiving: 0, hpApplied: 0 });
    }

    const selected = physical.value.amount > arts.value.amount
        ? { request: physicalRequest, calculated: physical }
        : { request: artsRequest, calculated: arts };
    const applied = applyDamage(selected.request, selected.calculated);
    assert.equal(applied.value.kind, "APPLIED");
    assert.deepEqual(applied.value.application, { hpBefore: 500, hpAfter: 320, hpLoss: 180 });
    assert.equal(getUnit(applied.state, 2).vitality.hp, 320);
    assert.equal(getUnit(applied.state, 1).vitality.hp, 520);
    assert.deepEqual(stateOf(applied.state, 1, calculation), stateOf(arts.state, 1, calculation));
    assert.equal(applied.state.execution.rngState, arts.state.execution.rngState);
    assert.deepEqual(stateOf(applied.state, 2, reception), { receiving: 1, hpApplied: 1 });
    assert.deepEqual(applied.state.events.map(event => [event.type, event.amount]), [["HEAL", 20], ["DAMAGE", 180]]);
    assert.equal(getUnit(physical.state, 1).vitality.hp, 510);
    assert.equal(getUnit(arts.state, 2).vitality.hp, 500);
    assert.deepEqual(stateOf(battle, 1, calculation), {
        formulaBudget: 5, outputBudget: 5, formulaRolls: [], outputInputs: [],
    });
    assert.equal(battle.execution.rngState, 0);
    assert.equal(getUnit(battle, 1).vitality.hp, 500);
    assert.deepEqual(battle.events, []);
});

test("damage calculation: the formula reads defense changed synchronously by a Formula Hook", () => {
    const fortify = damageEffect("fortify-before-formula", {}, [{
        stage: "targetFormula", invoke(state, context, _self, current) {
            return {
                state: transitionUnit(state, context.target.id, target => ({
                    ...target,
                    defense: setDefenseContribution(target.defense, {
                        id: "formula-defense", value: [modifier({ finalAddition: 80 })],
                    }),
                })),
                value: current,
            };
        },
    }]);
    const battle = workFor(unit(1), attach(unit(2, { defense: 10 }), fortify));
    const input = request(200);
    const calculated = calculateDamage(battle, input);

    assert.deepEqual(calculated.value, { type: "PHYSICAL", amount: 110 });
    assert.equal(getUnit(calculated.state, 2).defense.defense.length, 1);
    assert.equal(getUnit(calculated.state, 2).vitality.hp, 5000);
    assert.equal(getUnit(battle, 2).defense.defense.length, 0);
    assert.equal(applyDamage(input, calculated).value.application.hpLoss, 110);
});

test("damage calculation: Formula removal rejects the result while retaining its completed state prefix", () => {
    const departure = damageEffect("formula-departure", { budget: 2 }, [
        { stage: "sourceFormula", priority: 200, invoke(state, context, self, current) {
            state = setSelf(state, context, self, data => ({ ...data, budget: data.budget - 1 }));
            state = healing(state, {
                source: { id: 1 }, target: { id: 1 }, parameters: { power: 10, multiplier: 1 },
            }).state;
            return { state, value: current };
        } },
        { stage: "sourceFormula", priority: 100, invoke(state, context, _self, current) {
            return {
                state: leave(state, context.target.id, "SCRIPT"),
                value: current,
            };
        } },
        { stage: "sourceFormula", invoke() { assert.fail("Formula dispatch must stop when the target leaves"); } },
        { stage: "output", invoke() { assert.fail("an unavailable target cannot reach Output"); } },
    ]);
    const battle = workFor(attach(unit(1, { hp: 50, maxHp: 100 }), departure), unit(2));
    const calculated = calculateDamage(battle, request(100));

    assert.equal(calculated.value, undefined);
    assert.equal(stateOf(calculated.state, 1, departure).budget, 1);
    assert.equal(getUnit(calculated.state, 1).vitality.hp, 60);
    assert.equal(getUnit(calculated.state, 2), undefined);
    assert.deepEqual(calculated.state.removedUnits.map(({ unitId, reason }) => [unitId, reason]), [[2, "SCRIPT"]]);
    assert.deepEqual(calculated.state.events.map(event => [event.type, event.amount]), [["HEAL", 10]]);
    assert.equal(stateOf(battle, 1, departure).budget, 2);
    assert.equal(getUnit(battle, 1).vitality.hp, 50);
    assert.ok(getUnit(battle, 2));
    assert.deepEqual(battle.removedUnits, []);
    assert.deepEqual(battle.events, []);
});
