import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { unit, battle } from "../helpers/action-fixture.js";
import { stun } from "../../dist/content/tactical/effects/stun.js";
import { silence, blockSpRecovery } from "../../dist/content/tactical/effects/control.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { getUnit, battlefieldView, updateUnit } from "../../dist/core/tactical/battle/state.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { canBlock } from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import { canMove } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { definition as skillDefinition } from "../helpers/skill.js";
import { activate, advance } from "../../dist/core/tactical/unit/capability/skill/operations.js";
import { recover } from "../../dist/core/tactical/unit/capability/skill/sp.js";

const activationAllowed = (state) => {
    const unit = getUnit(state, 0);
    const ready = updateUnit(state, { ...unit, skill: { ...unit.skill, sp: { ...unit.skill.sp, value: 10 } } });
    return activate(ready, unitRef(unit)).value.type === "ACTIVATED";
};
const recoveryAllowed = (state) => recover(state, unitRef(getUnit(state, 0)), "TIME", 0).value.type === "APPLIED";
const actionAllowed = (battle, self) => self.action.rules.every(rule => rule.allows(battle, self, "normal"));

function actor(action = true) {
    return unit(0, {
        action,
        blocker: { capacity: 1, geometry: { radius: 2 } },
        locomotion: { moveSpeedPerTick: 1, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 } },
        skill: skillDefinition({ id: "control-test", sp: { initial: 0, capacity: 10, requirement: 10, recovery: { type: "TIME", intervalTicks: 30 } } }),
    });
}

test("stun composes four capabilities and overlapping instances withdraw only their own rules", () => {
    const original = battle(actor(), unit(1, { blockable: { volume: 1 } }));
    const first = effects.install(original, unitRef(getUnit(original, 0)), stun, { scopes: [{ type: "TICK", tick: 5 }] });
    const second = effects.install(first.state, unitRef(getUnit(first.state, 0)), stun);
    const host = getUnit(second.state, 0);

    assert.equal(actionAllowed(second.state, host), false);
    assert.equal(canMove(second.state, host), false);
    assert.equal(canBlock(host), false);
    assert.equal(activationAllowed(second.state), false);
    assert.equal(recoveryAllowed(second.state), true);
    assert.equal(battlefieldView(second.state).blockerOf(1), undefined);

    let state = effects.setEnabled(second.state, first.value, false);
    assert.equal(actionAllowed(state, getUnit(state, 0)), false);
    state = effects.end(state, second.value, "EXPLICIT");
    assert.equal(actionAllowed(state, getUnit(state, 0)), true);
    assert.equal(canMove(state, getUnit(state, 0)), true);
    assert.equal(canBlock(getUnit(state, 0)), true);
    assert.equal(activationAllowed(state), true);
    assert.equal(battlefieldView(state).blockerOf(1), 0);

    state = effects.setEnabled(state, first.value, true);
    assert.equal(canBlock(getUnit(state, 0)), false);
    state = effects.advance({ ...state, tick: 5 });
    assert.equal(canBlock(getUnit(state, 0)), true);
    assert.equal(battlefieldView(state).blockerOf(1), 0);
    assert.equal(actionAllowed(original, getUnit(original, 0)), true);
    assert.equal(actionAllowed(second.state, host), false);
});

test("silence and SP prevention are separate rules, and prohibited time does not accrue SP", () => {
    const host = actor();
    const silenced = effects.install(battle(host), unitRef(host), silence);
    const blocked = effects.install(silenced.state, unitRef(getUnit(silenced.state, 0)), blockSpRecovery);
    let state = blocked.state;

    assert.equal(activationAllowed(state), false);
    assert.equal(actionAllowed(state, getUnit(state, 0)), true);
    assert.equal(canMove(state, getUnit(state, 0)), true);
    assert.equal(canBlock(getUnit(state, 0)), true);
    assert.equal(recoveryAllowed(state), false);
    assert.equal(recover(state, unitRef(getUnit(state, 0)), "EXTERNAL", 1).state, state);
    state = advance({ ...state, tick: 60 }, unitRef(getUnit(state, 0)));
    assert.equal(getUnit(state, 0).skill.sp.value, 0);
    assert.equal(getUnit(state, 0).skill.sp.lastTick, 60);
    state = effects.end(state, blocked.value, "EXPLICIT");
    state = advance({ ...state, tick: 61 }, unitRef(getUnit(state, 0)));
    assert.equal(getUnit(state, 0).skill.sp.value, 0);
    assert.equal(getUnit(state, 0).skill.sp.recovery.remainingTicks, 29);
    assert.equal(activationAllowed(state), false);
    assert.equal(recoveryAllowed(state), true);
    state = recover(state, unitRef(getUnit(state, 0)), "EXTERNAL", 1).state;
    assert.equal(getUnit(state, 0).skill.sp.value, 1);
    state = effects.end(state, silenced.value, "EXPLICIT");
    assert.equal(activationAllowed(state), true);
});

test("stun interrupts a running Action through its complete cancellation operation", () => {
    let endings = 0;
    const program = {
        id: "held", intervalTicks: 30, speed: 100,
        initialize: state => ({ state, value: {} }),
        start: state => ({ state, value: {} }),
        step: state => ({ state, value: false }),
        onEnd: state => { endings++; return state; },
    };
    const configured = actor(program);
    const started = actions.start(battle(configured), unitRef(configured), program);
    assert.equal(started.value.type, "STARTED");
    const stunned = effects.install(started.state, unitRef(configured), stun).state;
    assert.equal(actions.get(stunned, started.value.ref), undefined);
    assert.equal(endings, 1);
    assert.deepEqual(stunned.events.filter(event => event.type === "ACTION_CANCELLED").map(event => event.reason), ["INTERRUPTED"]);
    assert.equal(actions.get(started.state, started.value.ref).status, "RUNNING");
});
