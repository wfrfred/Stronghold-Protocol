import assert from "node:assert/strict";
import { test } from "node:test";
import { createBattleState, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { removeUnitWithEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { fixtureBattlefield } from "../helpers/battlefield.js";

const unit = (id, extra = {}) =>
    initializeUnit({
        id,
        position: [0, id],
        definition: { id: `lifecycle-unit-${id}`, vitality: { maxHp: 100 }, ...extra },
    });

test("unit departure: callbacks observe LEAVING while old snapshots remain PRESENT", () => {
    const battle = createBattleState(fixtureBattlefield([unit(0)]));
    const trace = [];
    const observe = (stage) => {
        const current = getUnit(battle, 0);
        trace.push([stage, current.lifecycle]);
        removeUnitWithEffects(battle, 0, "DEATH", resources, 0);
        assert.equal(getUnit(battle, 0), current);
    };
    const resources = {
        stopSkillActivation() {
            observe("stop skill");
            return null;
        },
        notifySkillFinished() {
            assert.fail("a unit without an active skill must not notify skill completion");
        },
    };
    effects.install(battle, getUnit(battle, 0), {
        id: "departure-observer",
        initialize: () => ({}),
        onDisable: () => observe("disable effect"),
        onEnd: () => observe("end effect"),
    });
    const before = battle.battlefield.snapshot("draft");

    removeUnitWithEffects(battle, 0, "RETREAT", resources, 0);

    assert.deepEqual(trace, [
        ["stop skill", "LEAVING"],
        ["disable effect", "LEAVING"],
        ["end effect", "LEAVING"],
    ]);
    assert.equal(before.getUnit(0).lifecycle, "PRESENT");
    assert.equal(before.getUnit(0).effects.instances[0].status, "ACTIVE");
    assert.equal(battle.battlefield.snapshot("state").getUnit(0).lifecycle, "PRESENT");
    assert.equal(getUnit(battle, 0), undefined);
    assert.deepEqual(
        battle.removedUnits.map(({ unitId, reason }) => [unitId, reason]),
        [[0, "RETREAT"]],
    );
    assert.equal(battle.closedLifetimes.has("UNIT:0"), false);
});

test("unit departure: skill finish sees LEAVING and cannot install dependencies on its departing source", () => {
    const skill = createSkillDefinition({
        id: "departing-skill",
        activation: "MANUAL",
        spRecovery: "NONE",
        spCost: 1,
        initialSp: 1,
        durationTicks: null,
    });
    const resources = new CombatResources();
    const battle = createBattleState(fixtureBattlefield([unit(0, { skill }), unit(1)]));
    const statuses = [];
    let installations = 0;
    resources.skills.register({
        definition: skill,
        activate: () => ({ type: "ACTIVATED" }),
        finish(context) {
            statuses.push(context.facts.getUnit(0).lifecycle);
            removeUnitWithEffects(context.battle, 0, "DEATH", resources, context.tick);
            const rejected = effects.install(
                context.battle,
                getUnit(context.battle, 1),
                {
                    id: "late-dependency",
                    initialize: () => ({}),
                    onInstall() {
                        installations++;
                    },
                },
                {
                    scopes: [{ type: "UNIT", unitId: 0 }],
                },
            );
            assert.equal(rejected, undefined);
        },
    });
    activateSkill(battle, { unitId: 0, tick: 0 }, resources);
    const before = battle.battlefield.snapshot("draft");

    removeUnitWithEffects(battle, 0, "SCRIPT", resources, 1);

    assert.deepEqual(statuses, ["LEAVING"]);
    assert.equal(installations, 0);
    assert.equal(getUnit(battle, 1).effects.nextId, 0);
    assert.equal(before.getUnit(0).lifecycle, "PRESENT");
    assert.ok(before.getUnit(0).skill.active);
    assert.equal(getUnit(battle, 0), undefined);
    assert.equal(battle.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
    assert.deepEqual(
        battle.removedUnits.map(({ unitId, reason }) => [unitId, reason]),
        [[0, "SCRIPT"]],
    );
});
