import { fixtureBattle } from "../helpers/unit.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";

import { createBattleState, getUnit } from "../../dist/core/tactical/battle/state.js";
import { deploy, retreat } from "../../dist/core/tactical/battle/deployment/operations.js";
import {
    addCard, advance, changeDp, getCard, initialize as initializeDeployment, updateCard,
} from "../../dist/core/tactical/battle/deployment/deployment.js";
import * as cards from "../../dist/core/tactical/battle/deployment/card.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import {
    createDefinition as createDeployable, initialize as initializeDeployable,
} from "../../dist/core/tactical/unit/capability/deployable/capability.js";
import { initialize as initializeUnit } from "../helpers/unit.js";
import { create as createBattlefield } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/attribute.js";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";

const tile = createTile({
    heightType: "LOWLAND", buildableType: "ALL", passableMask: "ALL",
    playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
});
const map = createBattlefieldMap(1, 8, Array(8).fill(tile));

const definition = (fields = {}) => ({
    id: "operator", vitality: { maxHp: 100 }, occupancy: {},
    deployable: createDeployable({ cost: 10, redeployTicks: 3, slots: 1, buildableType: "ALL" }),
    ...fields,
});
const budget = (fields = {}) => ({
    initialDp: 100, maxDp: 100, dpRecoveryTicks: null, slotLimit: null, ...fields,
});
const supply = (fields = {}) => ({
    stockLimit: 3, activeLimit: null, recharge: "DEPLOYMENT", costPenalty: false, ...fields,
});
const fixture = (inputs, fields = {}) => {
    let state = createBattleState(
        createBattlefield({ map }), undefined, undefined, 0,
        initializeDeployment(budget(fields)),
    );
    for (const input of inputs) state = addCard(state, input).state;
    return state;
};
const request = (cardId = 0, column = 0) => ({
    cardId, tilePosition: [0, column], playerSide: "SIDE_A",
});
const at = (state, tick) => advance({ ...state, tick }, tick);
const deployUnit = (state, cardId = 0, column = 0) => {
    const result = deploy(state, request(cardId, column));
    assert.equal(result.value.type, "DEPLOYED");
    return result;
};
const reject = (state, input, reason) => {
    const result = deploy(state, input);
    assert.deepEqual(result.value, { type: "REJECTED", reason });
    assert.equal(result.state.execution, state.execution);
    assert.equal(result.state.deployment.dp, state.deployment.dp);
    assert.equal(result.state.deployment.cards, state.deployment.cards);
    assert.equal(result.state.battlefield, state.battlefield);
};

test("deployment binds its Card and snapshots field COST independently of later Card discounts", () => {
    const unit = definition({
        deployable: createDeployable({ cost: 20, redeployTicks: 0, slots: 1, buildableType: "ALL" }),
    });
    const previous = fixture([{ unit }]);
    const deployed = deployUnit(previous);
    let state = deployed.state;
    const field = getUnit(state, deployed.value.unitId);
    assert.equal(field.deployable.cardId, 0);
    assert.equal(field.deployable.cost, 20);
    assert.equal(field.deployable.refundLimit, 20);
    assert.equal(state.deployment.dp, 80);
    assert.equal(state.execution.nextUnitId, 1);
    assert.equal(previous.execution.nextUnitId, 0);
    assert.equal(previous.deployment.dp, 100);

    state = updateCard(state, cards.setCostContribution(getCard(state, 0), {
        id: "later-discount", value: [modifier({ finalAddition: -18 })],
    }));
    assert.equal(cards.resolveCost(getCard(state, 0)), 2);
    state = retreat(state, field.id);
    assert.equal(state.deployment.dp, 90);
    assert.equal(getCard(state, 0).costStage, 1);
    assert.equal(getCard(state, 0).cooldown, null);
    assert.equal(field.deployable.cost, 20);
    assert.equal(getUnit(state, field.id), undefined);

    const redeployed = deployUnit(state, 0, 1);
    assert.equal(getUnit(redeployed.state, redeployed.value.unitId).deployable.cost, 12);
    assert.equal(redeployed.state.deployment.dp, 78);
});

test("return cooldown and cost penalty follow departure; death refunds no DP", () => {
    let { state, value } = deployUnit(fixture([{ unit: definition() }]));
    assert.equal(getCard(state, 0).cooldown, null);
    state = retreat(at(state, 5), value.unitId);
    assert.equal(state.deployment.dp, 95);
    assert.deepEqual(getCard(state, 0).cooldown, { readyAtTick: 8, durationTicks: 3 });
    reject(state, request(), "COOLDOWN");
    ({ state, value } = deployUnit(at(state, 8)));
    assert.equal(state.deployment.dp, 80);
    assert.equal(getUnit(state, value.unitId).deployable.cost, 15);

    state = leave(at(state, 10), value.unitId, "DEATH");
    assert.equal(state.deployment.dp, 80);
    assert.equal(getCard(state, 0).costStage, 2);
    assert.deepEqual(getCard(state, 0).cooldown, { readyAtTick: 13, durationTicks: 3 });
    ({ state, value } = deployUnit(at(state, 13)));
    assert.equal(getUnit(state, value.unitId).deployable.cost, 20);
    state = retreat(state, value.unitId);
    assert.equal(getCard(state, 0).costStage, 2);
});

test("two Cards of the same definition have separate active limits, cooldowns and cost penalties", () => {
    const unit = definition();
    let state = fixture([{ unit }, { unit }]);
    const first = deployUnit(state, 0, 0);
    const second = deployUnit(first.state, 1, 1);
    state = retreat(at(second.state, 2), first.value.unitId);
    assert.equal(getCard(state, 0).definition.unit, getCard(state, 1).definition.unit);
    assert.equal(getCard(state, 0).costStage, 1);
    assert.equal(getCard(state, 1).costStage, 0);
    assert.equal(getCard(state, 1).cooldown, null);
    assert.equal(getUnit(state, second.value.unitId).deployable.cardId, 1);
    reject(state, request(1, 2), "ACTIVE_LIMIT");
    assert.equal(cards.resolveCost(getCard(state, 0)), 15);
    assert.equal(cards.resolveCost(getCard(state, 1)), 10);
});

test("deployment rejection leaves stock, DP, Unit allocation and battlefield unchanged", () => {
    const unit = definition();
    reject(fixture([{ unit }]), request(99), "UNKNOWN_CARD");
    reject(fixture([{ unit }], { initialDp: 9 }), request(), "INSUFFICIENT_DP");
    reject(fixture([{ unit }], { slotLimit: 0 }), request(), "SLOT_LIMIT");
    reject(fixture([{ unit }]), request(0, 8), "OUTSIDE_MAP");

    const occupied = deployUnit(fixture([{ unit }, { unit }])).state;
    reject(occupied, request(1), "OCCUPIED");
    reject(occupied, request(0, 1), "ACTIVE_LIMIT");

    const slotted = deployUnit(fixture([{ unit }, { unit }], { slotLimit: 1 })).state;
    reject(slotted, request(1, 1), "SLOT_LIMIT");

    const finite = deployUnit(fixture([{ unit, supply: supply({ stockLimit: 1 }) }])).state;
    assert.equal(getCard(finite, 0).stock, 0);
    reject(finite, request(0, 1), "NO_STOCK");

    const waiting = deployUnit(fixture([{ unit, supply: supply() }])).state;
    assert.equal(getCard(waiting, 0).stock, 2);
    reject(waiting, request(0, 1), "COOLDOWN");
});

test("DP recovery stops at its cap and starts a fresh interval after spending", () => {
    let state = fixture([], { initialDp: 1, maxDp: 3, dpRecoveryTicks: 2 });
    state = at(state, 2);
    assert.equal(state.deployment.dp, 2);
    assert.equal(state.deployment.nextDpRecoveryAtTick, 4);
    state = at(state, 100);
    assert.equal(state.deployment.dp, 3);
    assert.equal(state.deployment.nextDpRecoveryAtTick, null);
    state = { ...state, tick: 101, deployment: changeDp(state.deployment, -1, 101) };
    assert.equal(state.deployment.nextDpRecoveryAtTick, 103);
    assert.equal(at(state, 102).deployment.dp, 2);
    state = at(state, 103);
    assert.equal(state.deployment.dp, 3);
    assert.equal(state.deployment.nextDpRecoveryAtTick, null);
});

test("queued supply permits deploying remaining stock while returned Units recharge serially", () => {
    const unit = definition({
        deployable: createDeployable({ cost: 0, redeployTicks: 4, slots: 1, buildableType: "ALL" }),
    });
    const first = deployUnit(fixture([{ unit, supply: supply({ recharge: "QUEUED" }) }]), 0, 0);
    const second = deployUnit(first.state, 0, 1);
    let state = retreat(at(second.state, 1), first.value.unitId);
    state = retreat(at(state, 2), second.value.unitId);
    assert.equal(getCard(state, 0).stock, 1);
    assert.equal(getCard(state, 0).pendingReturns, 2);
    assert.equal(getCard(state, 0).cooldown.readyAtTick, 5);

    const third = deployUnit(state, 0, 2);
    state = third.state;
    assert.equal(getCard(state, 0).stock, 0);
    reject(state, request(0, 3), "NO_STOCK");
    state = at(state, 5);
    assert.equal(getCard(state, 0).stock, 1);
    assert.equal(getCard(state, 0).pendingReturns, 1);
    assert.equal(getCard(state, 0).cooldown.readyAtTick, 9);
    assert.equal(getCard(at(state, 8), 0).stock, 1);
    state = at(state, 9);
    assert.equal(getCard(state, 0).stock, 2);
    assert.equal(getCard(state, 0).pendingReturns, 0);
    assert.equal(getCard(state, 0).cooldown, null);
    assert.notEqual(getUnit(state, third.value.unitId), undefined);
});

test("preset Units without a Card do not recycle; refund eligibility is a separate fact", () => {
    const unit = definition();
    const ordinary = initializeUnit({ id: 10, definition: unit, position: [0, 0] });
    const refundable = initializeUnit({
        id: 11, definition: unit, position: [1, 0],
        states: { deployable: { ...initializeDeployable(fixtureBattle(0), unit.deployable).value, refundAllowed: true } },
    });
    let state = createBattleState(
        fixtureBattlefieldState([ordinary, refundable]), undefined, undefined, 0,
        initializeDeployment(budget({ initialDp: 20 })),
    );
    state = retreat(state, ordinary.id);
    assert.equal(state.deployment.dp, 20);
    state = retreat(state, refundable.id);
    assert.equal(state.deployment.dp, 25);
    assert.deepEqual(state.deployment.cards, []);
    assert.equal(state.execution.nextCardId, 0);
});

test("entry-triggered death recycles its Card before the Unit departure callback", () => {
    const calls = [];
    const unit = definition({
        onEnter(state, id) {
            calls.push("entered");
            return leave(state, id, "DEATH");
        },
        onLeave(state, departure) {
            calls.push("left");
            assert.equal(getUnit(state, departure.unit.id), undefined);
            assert.equal(getCard(state, 0).costStage, 1);
            assert.equal(getCard(state, 0).cooldown.readyAtTick, 3);
            assert.equal(state.deployment.dp, 90);
            return state;
        },
    });
    const previous = fixture([{ unit }]);
    const result = deployUnit(previous);
    assert.deepEqual(calls, ["entered", "left"]);
    assert.equal(getUnit(result.state, result.value.unitId), undefined);
    assert.equal(result.state.removedUnits.length, 1);
    assert.equal(result.state.events.filter((event) => event.type === "UNIT_DEPLOYED").length, 1);
    assert.equal(getCard(previous, 0).costStage, 0);
});

test("zero-cooldown departure can redeploy synchronously without overwriting the nested result", () => {
    let replacementId;
    const unit = definition({
        deployable: createDeployable({ cost: 10, redeployTicks: 0, slots: 1, buildableType: "ALL" }),
        onLeave(state, departure) {
            assert.equal(getCard(state, 0).cooldown, null);
            assert.equal(getCard(state, 0).costStage, 1);
            const replacement = deployUnit(state, departure.unit.deployable.cardId, 1);
            replacementId = replacement.value.unitId;
            return replacement.state;
        },
    });
    const first = deployUnit(fixture([{ unit }]));
    const next = retreat(first.state, first.value.unitId);
    assert.equal(replacementId, 1);
    assert.equal(getUnit(next, first.value.unitId), undefined);
    assert.equal(getUnit(next, replacementId).deployable.cost, 15);
    assert.equal(next.execution.nextUnitId, 2);
    assert.equal(next.deployment.dp, 80);
    assert.equal(getCard(next, 0).costStage, 1);
    assert.equal(next.events.filter((event) => event.type === "UNIT_DEPLOYED").length, 2);
    assert.notEqual(getUnit(first.state, first.value.unitId), undefined);
});

test("a failed Tick publishes neither preceding deployments nor Card, DP and identity changes", () => {
    const failure = new Error("entry failed");
    const runtime = new BattleRuntime({
        map, schedule: { type: "TIMELINE", spawns: [] },
        initialUnits: [], predefines: [], initialMechanisms: [], initialNavigationModifiers: [],
        maxTicks: 3, routeMoveMultiplier: 1, rngState: 1,
        deployment: {
            definition: budget(),
            cards: [{ unit: definition() }, { unit: definition({ onEnter() { throw failure; } }) }],
        },
    });
    const before = runtime.snapshot();
    assert.throws(() => runtime.step([
        { type: "DEPLOY_UNIT", ...request(0, 0) },
        { type: "DEPLOY_UNIT", ...request(1, 1) },
    ]), (error) => error === failure);
    const after = runtime.snapshot();
    assert.equal(after.deployment, before.deployment);
    assert.equal(after.execution, before.execution);
    assert.equal(after.deployment.dp, 100);
    assert.equal(after.execution.nextCardId, 2);
    assert.equal(after.execution.nextUnitId, 0);
    assert.equal(after.tickIndex, 0);
    assert.deepEqual(after.units, []);
    assert.equal(after.result, null);
});
