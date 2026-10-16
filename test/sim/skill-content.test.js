import { fixtureBattle } from "../helpers/unit.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { create as createAttack } from "../../dist/content/tactical/actions/attack.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";
import { initialize as initializeVitality } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { battlefieldView, getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import * as skills from "../../dist/core/tactical/unit/capability/skill/operations.js";
import { initialize } from "../helpers/unit.js";
import { compileArknightsAttackBuffSkill } from "../../dist/data/arknights/skill-buff.js";
import { parseArknightsSkillLevel } from "../../dist/data/arknights/skill-definition.js";
import { createDefinition as createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import * as sp from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { effectFixtureWork } from "../helpers/effects.js";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";

const attackBuff = {
  skillId: "skcom_atk_up[1]",
  levels: [{
    name: "攻击力强化·α型",
    skillType: "MANUAL",
    durationType: "NONE",
    spData: { spType: "INCREASE_WITH_TIME", maxChargeTime: 1, spCost: 50, initSp: 0, increment: 1 },
    duration: 20,
    blackboard: [{ key: "atk", value: 0.1, valueStr: null }],
  }],
};

test("native Attack Enhancement Alpha level 1 charges, buffs attack for 20 seconds, ends, and charges again", () => {
  const compiled = compileArknightsAttackBuffSkill(attackBuff, 1);
  const unit = initialize({
    id: 1, position: [0, 0],
    definition: { id: "real-skill-fixture", skill: compiled, offense: { attack: 100 } },
  });
  let work = effectFixtureWork(unit);
  assert.equal(skills.activate(work, unitRef(getUnit(work, 1))).value.reason, "INSUFFICIENT_SP");
  work = skills.advance({ ...work, tick: 1500 }, unitRef(getUnit(work, 1)));
  assert.equal(getUnit(work, 1).skill.sp.value, 50);
  const active = skills.activate(work, unitRef(getUnit(work, 1)));
  work = active.state;
  assert.equal(active.value.type, "ACTIVATED");
  assert.equal(getUnit(work, 1).skill.active.sustain.endsAtTick, 2100);
  assert.equal(Math.round(resolveAttackPower(1, battlefieldView(work))), 110);
  work = skills.advance({ ...work, tick: 2099 }, unitRef(getUnit(work, 1)));
  assert.equal(getUnit(work, 1).skill.sp.value, 0);
  work = skills.advance({ ...work, tick: 2100 }, unitRef(getUnit(work, 1)));
  assert.equal(resolveAttackPower(1, battlefieldView(work)), 100);
  assert.equal(getUnit(work, 1).skill.active, null);
  work = skills.advance({ ...work, tick: 2130 }, unitRef(getUnit(work, 1)));
  assert.equal(getUnit(work, 1).skill.sp.value, 1);
});

test("native attack buff data builds a shared Definition and changes attacks through BattleRuntime", () => {
  const compiled = compileArknightsAttackBuffSkill(attackBuff, 1);
  const geometry = { shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 2 }] };
  const actor = {
    id: "native-skill-actor", vitality: { maxHp: 1000 }, offense: { attack: 100 },
    allegiance: { side: "ALLY" }, spatial: { layer: "GROUND" }, skill: compiled,
    action: { definitions: Definitions.empty().add(createAttack({ id: "normal",
      triggerBindingId: "target", intervalTicks: 30, recoveryTicks: 0, followUps: [],
      targetGroups: [{ id: "target", targeting: {
        type: "DAMAGE", scope: { type: "RANGE", geometry: { type: "SHAPES", geometry } },
        canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
        ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1,
      }, operations: [{ type: "DAMAGE", powerSource: "SOURCE_ATTACK", power: 1, damageType: "TRUE" }] }],
    })) },
  };
  const target = {
    id: "stationary-content-target", spatialPresence: {}, vitality: { maxHp: 1000000 }, allegiance: { side: "ENEMY" },
    spatial: { layer: "GROUND" }, hit: { geometry },
    locomotion: { moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 } },
  };
  const base = createLegacyCombatSpec({ rows: 1, columns: 3, operators: [], enemies: [], maxTicks: 2200 });
  const runtime = new BattleRuntime({ ...base, initialUnits: [{ definition: actor, position: [0, 0] }],
    schedule: { type: "TIMELINE", spawns: [{ definition: target, tick: 0,
      route: { pathMotionMode: "WALK", startPosition: [0, 1], endPosition: [0, 2], spawnOffset: [0, 0],
        spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false, visitEveryTileCenter: false,
        visitEveryNodeCenter: false, visitEveryCheckPoint: true },
      timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false,
    }] },
  });
  const current = () => runtime.snapshot().units.find(unit => unit.id === 0);

  for (let tick = 0; tick < 1500; tick++) { runtime.step(); }
  assert.equal(current().skill.sp.value, 49);
  const activated = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.equal(current().skill.active.sustain.endsAtTick, 2100);
  assert.equal(Math.round(activated.events.find(event => event.type === "DAMAGE").amount), 110);
  for (let tick = 1501; tick < 2100; tick++) { runtime.step(); }
  const ended = runtime.step();
  assert.equal(ended.events.find(event => event.type === "DAMAGE").amount, 100);
  assert.equal(current().skill.active, null);
});

test("native SP enums and timing values decode without interpreting unrelated terrain skill blackboards", () => {
  const records = [
    ["skchr_chen_1", "AUTO", "INCREASE_WHEN_ATTACK", 7, 0, 0, "ACTION"],
    ["skchr_mudrok_2", "AUTO", "INCREASE_WHEN_TAKEN_DAMAGE", 6, 0, 0, "HIT"],
    ["skchr_angel_2", "MANUAL", "INCREASE_WITH_TIME", 45, 15, 15, "TIME"],
    ["skchr_huang_2", "AUTO", "INCREASE_WITH_TIME", 90, 0, -1, "TIME"],
  ];
  for (const [id, type, spType, cost, initial, duration, expected] of records) {
    const parsed = parseArknightsSkillLevel({
      skillId: id,
      levels: [{ skillType: type, duration, spData: { spType, spCost: cost, initSp: initial, maxChargeTime: 1, increment: 1 }, blackboard: [] }],
    });
    assert.equal(parsed.definition.sp.recovery.type, expected);
    assert.equal(parsed.definition.sp.initial, initial);
    assert.deepEqual(parsed.definition.activation.sustain, duration === -1 ? { type: "INFINITE" } : { type: "TIME", durationTicks: duration * 30 });
  }
  const passive = parseArknightsSkillLevel({
    skillId: "skchr_brownb_1",
    levels: [{ skillType: "PASSIVE", duration: 0, spData: { spType: 8, spCost: 0, initSp: 0, maxChargeTime: 0, increment: 0 }, blackboard: [] }],
  });
  assert.equal(passive.definition.sp.recovery.type, "NONE");
  assert.equal(passive.definition.sp.capacity, 0);
  assert.throws(() => parseArknightsSkillLevel(attackBuff, 2), /unknown skill level/);
  assert.throws(() => parseArknightsSkillLevel({ ...attackBuff, levels: [{ ...attackBuff.levels[0], durationType: "AMMO", duration: -1 }] }), /requires an explicit ammunition count/);
  assert.throws(() => parseArknightsSkillLevel({ ...attackBuff, levels: [{ ...attackBuff.levels[0], spData: { ...attackBuff.levels[0].spData, spType: "unrecognized" } }] }), /unsupported skill SP/);
});

const unsheathe = {
  skillId: "skchr_chen_2",
  levels: [{
    skillType: "MANUAL", duration: 0,
    spData: { spType: "INCREASE_WHEN_ATTACK", spCost: 27, initSp: 10, maxChargeTime: 1, increment: 1 },
    blackboard: [{ key: "atk_scale", value: 3.3, valueStr: null }, { key: "max_target", value: 4, valueStr: null }],
  }],
};

test("native ACTION and HIT recovery retain content-defined integer increments", () => {
  for (const [spType, expected] of [["INCREASE_WHEN_ATTACK", "ACTION"], ["INCREASE_WHEN_TAKEN_DAMAGE", "HIT"]]) {
    const parsed = parseArknightsSkillLevel({ ...unsheathe, levels: [{ ...unsheathe.levels[0],
      spData: { ...unsheathe.levels[0].spData, spType, increment: 2 },
    }] });
    assert.deepEqual(parsed.definition.sp.recovery, { type: expected, amount: 2 });
  }
});

test("native ammunition data requires an explicit budget and never creates a TIME deadline", () => {
  const record = { ...unsheathe, levels: [{ ...unsheathe.levels[0], durationType: "AMMO", duration: -1 }] };
  const parsed = parseArknightsSkillLevel(record, 1, 31);
  assert.deepEqual(parsed.definition.activation.sustain, { type: "AMMO", amount: 31 });
  assert.throws(() => parseArknightsSkillLevel(record), /explicit ammunition count/);
  assert.throws(() => parseArknightsSkillLevel(record, 1, 0.5), /integer/);
});

function instantDamageFixture(automatic = false, withTarget = true) {
  const parsed = parseArknightsSkillLevel(unsheathe);
  const reports = [];
  const definition = createSkillDefinition({ ...parsed.definition, activation: {
    ...parsed.definition.activation,
    trigger: automatic ? "AUTO" : "MANUAL",
    accepts: (battle) => (getUnit(battle, 2)?.vitality.hp ?? 0) > 0,
    onStart: (battle, self) => {
      for (const damageType of ["PHYSICAL", "ARTS"]) {
        const settled = resolveDamage(battle, { sourceUnitId: self.host.id, targetUnitId: 2,
          damageType, operands: createDamageOperands(330), tick: battle.tick });
        battle = settled.state;
        reports.push(settled.value);
      }
      return battle;
    },
  } });
  const unit = initialize({ id: 1, position: [0, 0], definition: { id: "instant-caster", skill: definition } });
  const enemy = initialize({ id: 2, position: [1, 0], definition: { id: "instant-target", vitality: { maxHp: 1000 } } });
  let work = effectFixtureWork(unit, ...(withTarget ? [enemy] : []));
  work = sp.modify(work, unitRef(unit), 17).state;
  return { work, reports };
}

test("native Unsheathe level 1 metadata supports synchronous physical and arts damage through a one-target content fixture", () => {
  const f = instantDamageFixture();
  const activated = skills.activate(f.work, unitRef(getUnit(f.work, 1)));
  f.work = activated.state;
  assert.equal(activated.value.type, "ACTIVATED");
  assert.equal(getUnit(f.work, 2).vitality.hp, 340);
  assert.equal(getUnit(f.work, 1).skill.active, null);
  assert.equal(f.reports.length, 2);
  assert.ok(f.reports.every((report) => report.request.tick === 0));
});

test("AUTO instant content keeps full SP when its required target is absent", () => {
  const f = instantDamageFixture(true, false);
  const advanced = skills.advance({ ...f.work, tick: 1 }, unitRef(getUnit(f.work, 1)));
  f.work = advanced;
  assert.equal(advanced.events.length, 0);
  assert.equal(getUnit(f.work, 1).skill.sp.value, 27);
  assert.equal(f.reports.length, 0);
});

test("instant healing uses the current activation tick and returns the settled healing report", () => {
  let report;
  const definition = createSkillDefinition({ id: "instant-heal-port", initialize: () => ({}), sp: null,
    activation: { trigger: "MANUAL", sustain: { type: "TIME", durationTicks: 0 }, initialize: () => ({}),
      onStart: (battle, self) => {
        const healed = resolveHealing(battle, { sourceUnitId: self.host.id, targetUnitId: self.host.id,
          power: 30, ignoreHealFree: false, tick: battle.tick });
        report = healed.value;
        return healed.state;
      },
    },
  });
  const unit = initialize({ id: 1, position: [0, 0], definition: { id: "heal-caster", skill: definition, vitality: { maxHp: 100 } }, states: { vitality: { ...initializeVitality(fixtureBattle(0), { maxHp: 100 }).value, hp: 50 } } });
  let activatedState = effectFixtureWork(unit);
  activatedState = skills.activate({ ...activatedState, tick: 3 }, unitRef(getUnit(activatedState, 1))).state;
  assert.equal(getUnit(activatedState, 1).vitality.hp, 80);
  assert.equal(report.amount, 30);
});
