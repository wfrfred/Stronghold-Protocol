import assert from "node:assert/strict";
import { test } from "node:test";
import { unit, battle } from "../helpers/action-fixture.js";
import { stun } from "../../dist/content/tactical/effects/stun.js";
import { silence, blockSpRecovery } from "../../dist/content/tactical/effects/control.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { getUnit, battlefieldView } from "../../dist/core/tactical/battle/state.js";
import { canAct } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { canBlock } from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import { canMove } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { canActivate, canGainSp, createDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { advanceSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { gainUnitSkillSp } from "../../dist/core/tactical/battle/execution/skill-sp.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";

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
    const first = effects.install(original, getUnit(original, 0), stun, { scopes: [{ type: "TICK", tick: 5 }] });
    const second = effects.install(first.state, getUnit(first.state, 0), stun);
    const host = getUnit(second.state, 0);

    assert.equal(canAct(host), false);
    assert.equal(canMove(host), false);
    assert.equal(canBlock(host), false);
    assert.equal(canActivate(host), false);
    assert.equal(canGainSp(host), true);
    assert.equal(battlefieldView(second.state).blockerOf(1), undefined);

    let state = effects.setEnabled(second.state, first.value, false);
    assert.equal(canAct(getUnit(state, 0)), false);
    state = effects.end(state, second.value, "EXPLICIT");
    assert.equal(canAct(getUnit(state, 0)), true);
    assert.equal(canMove(getUnit(state, 0)), true);
    assert.equal(canBlock(getUnit(state, 0)), true);
    assert.equal(canActivate(getUnit(state, 0)), true);
    assert.equal(battlefieldView(state).blockerOf(1), 0);

    state = effects.setEnabled(state, first.value, true);
    assert.equal(canBlock(getUnit(state, 0)), false);
    state = effects.advance({ ...state, tick: 5 });
    assert.equal(canBlock(getUnit(state, 0)), true);
    assert.equal(battlefieldView(state).blockerOf(1), 0);
    assert.equal(canAct(getUnit(original, 0)), true);
    assert.equal(canAct(host), false);
});

test("silence and SP prevention are separate rules, and prohibited time does not accrue SP", () => {
    const resources = new CombatResources();
    const host = actor();
    resources.skills.register({ definition: host.definition.skill, activate: state => ({ state, value: { type: "ACTIVATED" } }) });
    const silenced = effects.install(battle(host), host, silence);
    const blocked = effects.install(silenced.state, getUnit(silenced.state, 0), blockSpRecovery);
    let state = blocked.state;

    assert.equal(canActivate(getUnit(state, 0)), false);
    assert.equal(canAct(getUnit(state, 0)), true);
    assert.equal(canMove(getUnit(state, 0)), true);
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
