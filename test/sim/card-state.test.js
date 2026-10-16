import assert from "node:assert/strict";
import { test } from "node:test";
import * as cards from "../../dist/core/tactical/battle/deployment/card.js";
import { create as value } from "../../dist/core/tactical/unit/contribution/attribute.js";

const definition = (cost = 10, redeployTicks = 30) => ({
    id: "deployable",
    deployable: {
        cost, redeployTicks, slots: 1, buildableType: "ALL", advancedBuildableMask: 1,
        refund: { rate: 0.5, limit: "BASE_COST" },
    },
});
const operator = (cost = 10, redeployTicks = 30) =>
    cards.create(0, { unit: definition(cost, redeployTicks) });
const token = (recharge, stockLimit = 3, redeployTicks = 10) =>
    cards.create(1, {
        unit: definition(5, redeployTicks),
        supply: { stockLimit, activeLimit: stockLimit, recharge, costPenalty: false },
    });
const modification = (id, fields, group) => ({
    id, value: [value(fields)], ...(group === undefined ? {} : { group }),
});

test("ordinary operator Cards share definitions and have independent persistent progress", () => {
    const unit = definition();
    const first = cards.create(0, { unit });
    const second = cards.create(1, { unit });
    assert.equal(first.definition.unit, unit);
    assert.equal(first.definition.supply, cards.operatorSupply);
    assert.equal(first.stock, null);
    assert.equal(first.definition.supply.activeLimit, 1);
    assert.equal(first.cooldown, null);
    assert.equal(cards.consume(first, 0).cooldown, null);

    const recycled = cards.recycle(first, 5, "RETREAT");
    assert.equal(recycled.costStage, 1);
    assert.equal(second.costStage, 0);
    assert.equal(first.costStage, 0);
    assert.equal(first.cooldown, null);
});

test("cost penalty follows departures, caps at two, and excludes special movement", () => {
    let card = operator(11);
    assert.equal(cards.resolveCost(card), 11);
    card = cards.recycle(card, 1, "RETREAT");
    assert.equal(cards.resolveCost(card), 16);
    card = cards.recycle(card, 2, "DEATH");
    assert.equal(cards.resolveCost(card), 22);
    card = cards.recycle(card, 3, "RETREAT");
    assert.equal(card.costStage, 2);
    assert.equal(cards.resolveCost(card), 22);

    for (const reason of ["MOVE", "SCRIPT", "EXPIRED"]) {
        assert.equal(cards.recycle(operator(), 5, reason).costStage, 0);
    }
    assert.equal(cards.recycle(token("DEPLOYMENT"), 5, "DEATH").costStage, 0);
});

test("cost penalty multiplies base additions without multiplying final cost reductions", () => {
    const initial = operator(10);
    let card = cards.recycle(initial, 0, "RETREAT");
    card = cards.setCostContribution(card, modification("base", { addition: 2 }));
    card = cards.setCostContribution(card, modification("discount", { finalAddition: -4 }));
    assert.equal(cards.resolveBaseCost(card), 12);
    assert.equal(cards.resolveCost(card), 14);
    assert.equal(cards.resolveCost(initial), 10);

    card = cards.setCostContribution(card, modification("discount", { finalAddition: -99 }));
    assert.equal(cards.resolveCost(card), 0);
    assert.equal(cards.resolveBaseCost(card), 12);
});

test("Card contribution groups select a winner and removing it restores the fallback", () => {
    const initial = operator();
    let card = cards.setCostContribution(initial, modification("weak", { finalAddition: -1 }, { id: "discount", priority: 1 }));
    card = cards.setCostContribution(card, modification("strong", { finalAddition: -3 }, { id: "discount", priority: 2 }));
    assert.equal(cards.resolveCost(card), 7);
    card = cards.removeCostContribution(card, "strong");
    assert.equal(cards.resolveCost(card), 9);
    assert.equal(cards.resolveCost(initial), 10);
    assert.equal(cards.removeCostContribution(card, "missing"), card);
});

test("ordinary return starts cooldown at departure and clears it at the exact deadline", () => {
    const initial = operator(10, 30);
    const deployed = cards.consume(initial, 100);
    assert.equal(deployed.cooldown, null);
    const returned = cards.recycle(deployed, 125, "DEATH");
    assert.deepEqual(returned.cooldown, { readyAtTick: 155, durationTicks: 30 });
    assert.equal(cards.advance(returned, 154), returned);
    const ready = cards.advance(returned, 155);
    assert.equal(ready.cooldown, null);
    assert.equal(ready.stock, null);
    assert.equal(ready.costStage, 1);
    assert.equal(returned.cooldown.readyAtTick, 155);
});

test("default token cooldown begins on deployment and does not regenerate consumed stock", () => {
    const initial = token("DEPLOYMENT");
    const deployed = cards.consume(initial, 10);
    assert.equal(deployed.stock, 2);
    assert.deepEqual(deployed.cooldown, { readyAtTick: 20, durationTicks: 10 });
    assert.equal(cards.recycle(deployed, 12, "RETREAT"), deployed);
    const ready = cards.advance(deployed, 20);
    assert.equal(ready.cooldown, null);
    assert.equal(ready.stock, 2);
    assert.equal(initial.stock, 3);
});

test("unique token return restores one inventory item after its departure cooldown", () => {
    const initial = token("RETURN", 1, 10);
    const deployed = cards.consume(initial, 3);
    assert.equal(deployed.stock, 0);
    assert.equal(deployed.cooldown, null);
    const returned = cards.recycle(deployed, 7, "RETREAT");
    assert.equal(cards.advance(returned, 16), returned);
    const ready = cards.advance(returned, 17);
    assert.equal(ready.stock, 1);
    assert.equal(ready.cooldown, null);
});

test("queued returns cool serially while available inventory remains deployable", () => {
    const initial = token("QUEUED", 3, 30);
    let card = cards.consume(initial, 0);
    card = cards.consume(card, 0);
    card = cards.recycle(card, 5, "RETREAT");
    card = cards.recycle(card, 10, "RETREAT");
    assert.equal(card.stock, 1);
    assert.equal(card.pendingReturns, 2);
    assert.deepEqual(card.cooldown, { readyAtTick: 35, durationTicks: 30 });

    card = cards.consume(card, 12);
    assert.equal(card.stock, 0);
    assert.equal(card.cooldown.readyAtTick, 35);
    const firstReady = cards.advance(card, 35);
    assert.equal(firstReady.stock, 1);
    assert.equal(firstReady.pendingReturns, 1);
    assert.equal(firstReady.cooldown.readyAtTick, 65);
    assert.equal(cards.advance(firstReady, 64), firstReady);
    const nextReady = cards.advance(firstReady, 65);
    assert.equal(nextReady.stock, 2);
    assert.equal(nextReady.pendingReturns, 0);
    assert.equal(nextReady.cooldown, null);
    assert.equal(initial.stock, 3);
});

test("queued return progression can cross multiple elapsed deadlines", () => {
    let card = token("QUEUED", 3, 10);
    for (let i = 0; i < 3; i++) card = cards.consume(card, 0);
    for (let i = 0; i < 3; i++) card = cards.recycle(card, 1, "RETREAT");
    const ready = cards.advance(card, 31);
    assert.equal(ready.stock, 3);
    assert.equal(ready.pendingReturns, 0);
    assert.equal(ready.cooldown, null);
    assert.equal(card.stock, 0);
    assert.equal(card.pendingReturns, 3);
});

test("zero-duration cooldowns complete at the same tick, including all queued returns", () => {
    const returned = cards.recycle(cards.consume(token("RETURN", 1, 0), 5), 7, "RETREAT");
    assert.equal(cards.advance(returned, 7).stock, 1);
    let queued = token("QUEUED", 3, 0);
    for (let i = 0; i < 3; i++) queued = cards.consume(queued, 5);
    for (let i = 0; i < 3; i++) queued = cards.recycle(queued, 7, "RETREAT");
    const ready = cards.advance(queued, 7);
    assert.equal(ready.stock, 3);
    assert.equal(ready.pendingReturns, 0);
    assert.equal(ready.cooldown, null);
});

test("new redeployment modifiers do not rescale a cooldown that already started", () => {
    const initial = operator(10, 30);
    const returned = cards.recycle(initial, 5, "RETREAT");
    const modified = cards.setRedeployContribution(returned, modification("shorter", { multiplier: -0.5 }));
    assert.equal(cards.resolveRedeployTicks(modified), 15);
    assert.equal(modified.cooldown, returned.cooldown);
    assert.equal(modified.cooldown.readyAtTick, 35);

    const shortened = cards.reduceCooldown(modified, 10, 10);
    assert.equal(shortened.cooldown.readyAtTick, 25);
    assert.equal(shortened.cooldown.durationTicks, 30);
    assert.equal(cards.advance(shortened, 25).cooldown, null);
    assert.equal(cards.recycle(shortened, 50, "RETREAT").cooldown.readyAtTick, 65);
    assert.equal(cards.resolveRedeployTicks(cards.removeRedeployContribution(modified, "shorter")), 30);
    assert.equal(cards.removeRedeployContribution(modified, "missing"), modified);
});

test("queued timers keep their current duration and query new duration on the next cycle", () => {
    let card = token("QUEUED", 2, 30);
    card = cards.consume(cards.consume(card, 0), 0);
    card = cards.recycle(cards.recycle(card, 0, "RETREAT"), 0, "RETREAT");
    card = cards.setRedeployContribution(card, modification("shorter", { multiplier: -0.5 }));
    assert.equal(card.cooldown.readyAtTick, 30);
    const firstReady = cards.advance(card, 30);
    assert.equal(firstReady.stock, 1);
    assert.deepEqual(firstReady.cooldown, { readyAtTick: 45, durationTicks: 15 });
    assert.equal(cards.advance(firstReady, 45).stock, 2);
});

test("excess cooldown reduction applies to the current queued return only", () => {
    let card = token("QUEUED", 3, 30);
    for (let i = 0; i < 3; i++) card = cards.consume(card, 0);
    for (let i = 0; i < 3; i++) card = cards.recycle(card, 0, "RETREAT");
    card = cards.reduceCooldown(card, 100, 20);
    assert.equal(card.cooldown.readyAtTick, 20);
    const firstReady = cards.advance(card, 20);
    assert.equal(firstReady.stock, 1);
    assert.equal(firstReady.pendingReturns, 2);
    assert.equal(firstReady.cooldown.readyAtTick, 50);
    assert.equal(cards.advance(firstReady, 49), firstReady);
    assert.equal(cards.advance(firstReady, 50).stock, 2);
});

test("explicit recharge caps inventory without discarding the current timer", () => {
    const initial = cards.create(1, {
        unit: definition(),
        supply: { stockLimit: 5, activeLimit: 2, recharge: "DEPLOYMENT", costPenalty: false },
    }, 2);
    const deployed = cards.consume(initial, 10);
    const replenished = cards.recharge(deployed, 10);
    assert.equal(replenished.stock, 5);
    assert.equal(replenished.definition.supply.activeLimit, 2);
    assert.equal(replenished.cooldown, deployed.cooldown);
    assert.equal(cards.recharge(replenished, 1), replenished);
    assert.equal(cards.recharge(operator(), 5).stock, null);
    assert.equal(deployed.stock, 1);
});

test("Card construction rejects impossible finite inventory and consume does not underflow", () => {
    const supply = { stockLimit: 1, activeLimit: 1, recharge: "DEPLOYMENT", costPenalty: false };
    assert.throws(() => cards.create(0, { unit: definition(), supply }, 2), RangeError);
    assert.throws(() => cards.create(0, { unit: definition(), supply }, null), RangeError);
    assert.throws(() => cards.consume(cards.create(0, { unit: definition(), supply }, 0), 0), RangeError);
});
