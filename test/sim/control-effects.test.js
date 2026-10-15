import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { unit, battle } from "../helpers/action-fixture.js";
import { stun } from "../../dist/content/tactical/effects/stun.js";
import { silence, blockSpRecovery } from "../../dist/content/tactical/effects/control.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { getUnit, battlefieldView } from "../../dist/core/tactical/battle/state.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { canBlock } from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import { canMove } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { canActivate, canGainSp, createDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { advanceSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { gainUnitSkillSp } from "../../dist/core/tactical/battle/execution/skill-sp.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";

const actionAllowed = (battle, self) => self.action.rules.every(rule => rule.allows(battle, self, "normal"));

function actor() {
    return unit(0, {
        action: true,
        blocker: { capacity: 1, geometry: { radius: 2 } },
        locomotion: { moveSpeedPerTick: 1, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 } },
        skill: createDefinition({ id: "control-test", activation: "MANUAL", spRecovery: "TIME", spCost: 10, initialSp: 0, durationTicks: 1 }),
    });
}

test("stun composes four capabilities and overlapping instances withdraw only their own rules", () => {
    const original = battle(actor(), unit(1, { blockable: { weight: 1 } }));
    const first = effects.install(original, unitRef(getUnit(original, 0)), stun, { scopes: [{ type: "TICK", tick: 5 }] });
    const second = effects.install(first.state, unitRef(getUnit(first.state, 0)), stun);
    const host = getUnit(second.state, 0);

    assert.equal(actionAllowed(second.state, host), false);
    assert.equal(canMove(second.state, host), false);
    assert.equal(canBlock(host), false);
    assert.equal(canActivate(host), false);
    assert.equal(canGainSp(host), true);
    assert.equal(battlefieldView(second.state).blockerOf(1), undefined);

    let state = effects.setEnabled(second.state, first.value, false);
    assert.equal(actionAllowed(state, getUnit(state, 0)), false);
    state = effects.end(state, second.value, "EXPLICIT");
    assert.equal(actionAllowed(state, getUnit(state, 0)), true);
    assert.equal(canMove(state, getUnit(state, 0)), true);
    assert.equal(canBlock(getUnit(state, 0)), true);
    assert.equal(canActivate(getUnit(state, 0)), true);
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
    const resources = new CombatResources();
    const host = actor();
    resources.skills.register({ definition: host.definition.skill, activate: state => ({ state, value: { type: "ACTIVATED" } }) });
    const silenced = effects.install(battle(host), unitRef(host), silence);
    const blocked = effects.install(silenced.state, unitRef(getUnit(silenced.state, 0)), blockSpRecovery);
    let state = blocked.state;

    assert.equal(canActivate(getUnit(state, 0)), false);
    assert.equal(actionAllowed(state, getUnit(state, 0)), true);
    assert.equal(canMove(state, getUnit(state, 0)), true);
    assert.equal(canBlock(getUnit(state, 0)), true);
    assert.equal(canGainSp(getUnit(state, 0)), false);
    assert.equal(gainUnitSkillSp(state, 0, "EXTERNAL", 1), state);
    state = advanceSkill(state, 0, 60, resources);
    assert.equal(getUnit(state, 0).skill.sp, 0);
    assert.equal(getUnit(state, 0).skill.lastAdvancedTick, 60);
    state = effects.end(state, blocked.value, "EXPLICIT");
    state = advanceSkill(state, 0, 61, resources);
    assert.equal(getUnit(state, 0).skill.sp, 0);
    assert.equal(getUnit(state, 0).skill.spRecoveryProgressTicks, 1);
    assert.equal(canActivate(getUnit(state, 0)), false);
    assert.equal(canGainSp(getUnit(state, 0)), true);
    state = gainUnitSkillSp(state, 0, "EXTERNAL", 1);
    assert.equal(getUnit(state, 0).skill.sp, 1);
    state = effects.end(state, silenced.value, "EXPLICIT");
    assert.equal(canActivate(getUnit(state, 0)), true);
});

test("stun interrupts a running Action through its complete cancellation operation", () => {
    let endings = 0;
    const program = {
        id: "held", intervalTicks: 30, speed: 100,
        start: state => ({ state, value: {} }),
        step: state => ({ state, value: false }),
        onEnd: state => { endings++; return state; },
    };
    const source = actor();
    const configured = { ...source, definition: { ...source.definition,
        action: { definitions: Definitions.empty().add(program) } } };
    const started = actions.start(battle(configured), unitRef(configured), program);
    assert.equal(started.value.type, "STARTED");
    const stunned = effects.install(started.state, unitRef(configured), stun).state;
    assert.equal(actions.get(stunned, started.value.ref), undefined);
    assert.equal(endings, 1);
    assert.deepEqual(stunned.events.filter(event => event.type === "ACTION_CANCELLED").map(event => event.reason), ["INTERRUPTED"]);
    assert.equal(actions.get(started.state, started.value.ref).status, "RUNNING");
});
