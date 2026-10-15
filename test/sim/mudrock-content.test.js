import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepare } from "../../dist/data/arknights/operator.js";
import { create, readShield } from "../../dist/content/tactical/operators/mudrock.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import {
    createBattleState, battlefieldView, getUnit, updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { enterUnits } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { advance, end, install } from "../../dist/core/tactical/unit/effect/operations.js";
import { activateSkill, advanceSkill, finishSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { start, cancel } from "../../dist/core/tactical/unit/action/operations.js";
import { advance as advanceAction } from "../../dist/core/tactical/unit/action/advance.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { canMove } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { initialize as initializeTargetable, setRule as setTargetingRule } from "../../dist/core/tactical/unit/capability/targetable/capability.js";
import { invincible } from "../../dist/content/tactical/effects/protection.js";
import { setAttackContribution } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { setMaxHpContribution } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/value.js";
import { createRng } from "../../dist/core/common/rng.js";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";

const data = JSON.parse(readFileSync(new URL("../fixtures/arknights/main-mode-units.json", import.meta.url), "utf8"));
const moduleX = "uniequip_002_mudrok";
const profile = (fields = {}) => {
    const configuration = { elite: 2, level: 90, potential: 1, skillIndex: 1, skillLevel: 7, trust: 100, ...fields };
    return prepare({ id: "char_311_mudrok", record: data.characters.char_311_mudrok },
        data.skills.skchr_mudrok_2, configuration, {
            ranges: data.ranges, favor: data.favor,
            ...(configuration.module === undefined ? {} : {
                equipment: data.equipment[configuration.module.id],
                battleEquipment: data.battleEquipment[configuration.module.id],
            }),
        });
};
const enemy = (id, position, fields = {}) => initialize({ id, position, definition: {
    id: `enemy-${id}`, vitality: { maxHp: 10000 }, defense: { defense: 0, resistance: 0 },
    allegiance: { side: "ENEMY" }, spatial: { layer: "GROUND" },
    hit: { geometry: { shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.1 }] } },
    locomotion: { moveSpeedPerTick: 0.1, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } },
    ...fields,
} });
function setup(configuration = {}, targets = [], options = {}) {
    const combat = new CombatResources();
    const prepared = profile(configuration);
    const content = create(prepared, combat, options);
    const unit = initialize({ id: 0, position: [0, 0], definition: content.definition });
    const initial = createBattleState(fixtureBattlefieldState([unit, ...targets]));
    return { combat, prepared, ...content, initial, state: enterUnits(initial, [0]) };
}
const save = (state, fields) => updateUnit(state, { ...getUnit(state, 0), ...fields });
const hp = (state, amount) => save(state, { vitality: { ...getUnit(state, 0).vitality, hp: amount } });
const sp = (state, amount) => save(state, { skill: { ...getUnit(state, 0).skill, sp: amount } });
const hit = (state, combat, sourceUnitId = 1, power = 100) => resolveDamage(state, {
    sourceUnitId, targetUnitId: 0, damageType: "TRUE", operands: createDamageOperands(power), tick: state.tick,
}, combat);
const approximate = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const clearShield = (state, combat) => hit(state, combat).state;

test("entry installs one persistent shield container and preserves prior snapshots", () => {
    const { initial, state, prepared, combat } = setup();
    assert.equal(readShield(getUnit(initial, 0)), undefined);
    assert.deepEqual(readShield(getUnit(state, 0)), { layers: 1, timer: 270 });
    assert.equal(getUnit(state, 0).effects.values().filter(instance => instance.definition.id === "mudrock/shield").length, 1);
    assert.equal(getUnit(state, 0).definition.profile, prepared);
    assert.deepEqual(getUnit(state, 0).definition.deployable, {
        cost: prepared.attributes.cost, redeployTicks: prepared.attributes.respawnTime * 30,
        slots: 1, buildableType: "MELEE", advancedBuildableMask: 1,
        refund: { rate: 0.5, limit: "BASE_COST" },
    });
    assert.equal(getUnit(state, 0).deployable.refundAllowed, false);
    const externalHealing = resolveHealing(state, {
        sourceUnitId: null, targetUnitId: 0, power: 100, ignoreHealFree: false, tick: state.tick,
    }).value;
    assert.equal(externalHealing.amount, 0);
    assert.equal(externalHealing.cancellation.reason, "HEAL_FREE");
    const enteredLate = enterUnits({ ...initial, tick: 100 }, [0]);
    assert.deepEqual(readShield(getUnit(advance({ ...enteredLate, tick: 101 }), 0)), { layers: 1, timer: 269 });
});

test("shield cancels damage, consumes a layer, self-heals and retains normal HIT recovery", () => {
    const fixture = setup({}, [enemy(1, [1, 0])]);
    const before = hp(fixture.state, 1000);
    const result = hit(before, fixture.combat, 1, 5000);
    assert.equal(result.value.hpLoss, 0);
    assert.deepEqual(result.value.cancellation, { stage: "RECEPTION", reason: "MUDROCK_SHIELD" });
    assert.deepEqual(result.value.resourceConsumptions, [{ ownerUnitId: 0, resourceId: "mudrock/shield", resource: "SHIELD_LAYER", amount: 1 }]);
    approximate(getUnit(result.state, 0).vitality.hp, 1000 + fixture.prepared.attributes.maxHp * 0.2);
    assert.equal(getUnit(result.state, 0).skill.sp, 1);
    assert.deepEqual(readShield(getUnit(result.state, 0)), { layers: 0, timer: 270 });
    assert.equal(getUnit(result.state, 0).effects.values().find(instance => instance.definition.id === "mudrock/shield").status, "ACTIVE");
    assert.equal(getUnit(before, 0).vitality.hp, 1000);
    assert.deepEqual(readShield(getUnit(before, 0)), { layers: 1, timer: 270 });
    const external = resolveHealing(result.state, {
        sourceUnitId: 1, targetUnitId: 0, power: 1000, ignoreHealFree: false, tick: 0,
    });
    assert.equal(external.value.amount, 0);
    assert.equal(getUnit(external.state, 0).vitality.hp, getUnit(result.state, 0).vitality.hp);
    const unshielded = hit(result.state, fixture.combat);
    assert.equal(unshielded.value.hpLoss, 100);
});

test("invincible reception leaves shield untouched and removing its effect removes the hook", () => {
    const fixture = setup({}, [enemy(1, [1, 0])]);
    const protectedState = install(fixture.state, unitRef(getUnit(fixture.state, 0)), invincible).state;
    const canceled = hit(protectedState, fixture.combat);
    assert.equal(canceled.value.hpLoss, 0);
    assert.equal(readShield(getUnit(canceled.state, 0)).layers, 1);
    const effect = getUnit(fixture.state, 0).effects.values().find(instance => instance.definition.id === "mudrock/shield");
    const removed = end(fixture.state, { host: { id: 0 }, id: effect.id });
    assert.equal(readShield(getUnit(removed, 0)), undefined);
    assert.equal(hit(removed, fixture.combat).value.hpLoss, 100);
});

test("shield recharge keeps its periodic clock while capped and zero layers remain installed", () => {
    const fixture = setup({}, [enemy(1, [1, 0])]);
    let state = clearShield(fixture.state, fixture.combat);
    state = advance({ ...state, tick: 269 });
    assert.deepEqual(readShield(getUnit(state, 0)), { layers: 0, timer: 1 });
    state = advance({ ...state, tick: 270 });
    assert.deepEqual(readShield(getUnit(state, 0)), { layers: 1, timer: 270 });
    state = advance({ ...state, tick: 1000 });
    assert.deepEqual(readShield(getUnit(state, 0)), { layers: 3, timer: 80 });
    state = hit(state, fixture.combat).state;
    state = advance({ ...state, tick: 1080 });
    assert.deepEqual(readShield(getUnit(state, 0)), { layers: 3, timer: 270 });
    assert.equal(getUnit(state, 0).effects.values().filter(instance => instance.definition.id === "mudrock/shield").length, 1);
    const e1 = setup({ elite: 1, level: 80 });
    assert.equal(readShield(getUnit(advance({ ...e1.state, tick: 810 }), 0)).layers, 2);
});

test("module X healing and bonus SP use the selected talent and dynamic max HP", () => {
    const fixture = setup({ potential: 6, module: { id: moduleX, level: 3 } }, [enemy(1, [0.6, 0], { blockable: { weight: 1 } })]);
    let state = hp(fixture.state, 1000);
    state = save(state, { vitality: setMaxHpContribution(getUnit(state, 0).definition.vitality, getUnit(state, 0).vitality, {
        id: "test/max-hp", value: [modifier({ addition: 1000 })],
    }) });
    state = hp(state, 1000);
    const result = hit(state, fixture.combat);
    approximate(getUnit(result.state, 0).vitality.hp, 1000 + (fixture.prepared.attributes.maxHp + 1000) * 0.25);
    assert.equal(getUnit(result.state, 0).skill.sp, 3);
    assert.deepEqual(battlefieldView(result.state).blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);
    assert.equal(hit(result.state, fixture.combat).value.hpLoss, 85);
});

test("Sarkaz resistance and module blocked-source reduction compose only for their source conditions", () => {
    const fixture = setup({ module: { id: moduleX, level: 1 } }, [
        enemy(1, [0.6, 0], { blockable: { weight: 1 }, profile: { tags: ["sarkaz"] } }),
        enemy(2, [5, 0], { profile: { tags: ["sarkaz"] } }),
        enemy(3, [6, 0]),
    ]);
    const state = clearShield(fixture.state, fixture.combat);
    approximate(hit(state, fixture.combat, 1).value.hpLoss, 59.5);
    approximate(hit(state, fixture.combat, 2).value.hpLoss, 70);
    approximate(hit(state, fixture.combat, 3).value.hpLoss, 100);
    approximate(hit(state, fixture.combat, null).value.hpLoss, 100);
    const e1 = setup({ elite: 1, level: 80 }, [enemy(1, [1, 0], { profile: { tags: ["sarkaz"] } })]);
    assert.equal(hit(clearShield(e1.state, e1.combat), e1.combat).value.hpLoss, 100);
});

test("S2 does not consume SP without an eligible ground target in its range", () => {
    for (const receiver of [enemy(1, [5, 0]), enemy(1, [1, 0], { spatial: { layer: "AIR" } }),
        { ...enemy(1, [1, 0]), targetable: setTargetingRule(initializeTargetable(), {
            id: "not-selectable", allows: () => false,
        }) }]) {
        const fixture = setup({}, [receiver]);
        const ready = sp(fixture.state, 5);
        const result = activateSkill(ready, { unitId: 0, tick: 0, trigger: "AUTO" }, fixture.combat);
        assert.deepEqual(result.value, { type: "REJECTED", reason: "CONDITION" });
        assert.equal(getUnit(result.state, 0).skill.sp, 5);
        assert.equal(getUnit(result.state, 0).skill.active, null);
        assert.equal(result.state.events.some(event => event.type === "SKILL_ACTIVATED"), false);
    }
});

test("S2 immediately overrides normal attack and recovery cooldown, heals once, hits all eligible targets and finishes", () => {
    const fixture = setup({}, [enemy(1, [1, 0]), enemy(2, [0.8, 0]),
        enemy(3, [1, 0], { spatial: { layer: "AIR" } }), enemy(4, [5, 0])]);
    let ready = sp(hp(fixture.state, 1000), 5);
    ready = save(ready, {
        action: { ...getUnit(ready, 0).action, cooldowns: new Map([
            ["normal-attack", { readyAtTick: 10000, periodTicks: 60 }],
            [fixture.action.id, { readyAtTick: 10000, periodTicks: 60 }],
        ]) },
        offense: setAttackContribution(getUnit(ready, 0).offense, { id: "test/attack", value: [modifier({ addition: 100 })] }),
    });
    const active = advanceSkill(ready, 0, 0, fixture.combat);
    assert.equal(getUnit(active, 0).skill.active.endsAtTick, null);
    assert.equal(getUnit(active, 0).action.cooldowns.get("normal-attack").readyAtTick, 0);
    assert.equal(getUnit(active, 0).action.cooldowns.get(fixture.action.id).readyAtTick, 0);
    assert.equal(fixture.definition.skill.activeAction, fixture.action.id);
    const executed = start(active, unitRef(getUnit(active, 0)), fixture.action).state;
    const amount = (fixture.prepared.attributes.attack + 100) * 2.1;
    approximate(getUnit(executed, 1).vitality.hp, 10000 - amount);
    approximate(getUnit(executed, 2).vitality.hp, 10000 - amount);
    assert.equal(getUnit(executed, 3).vitality.hp, 10000);
    assert.equal(getUnit(executed, 4).vitality.hp, 10000);
    approximate(getUnit(executed, 0).vitality.hp, 1000 + fixture.prepared.attributes.maxHp * 0.05);
    assert.equal(getUnit(executed, 0).skill.active, null);
    assert.equal(getUnit(executed, 0).skill.sp, 0);
    assert.equal(executed.events.filter(event => event.type === "HEAL").length, 1);
    assert.equal(executed.events.filter(event => event.type === "DAMAGE").length, 2);
    assert.equal(executed.events.filter(event => event.type === "SKILL_FINISHED").length, 1);
    assert.equal(getUnit(active, 1).vitality.hp, 10000);
    assert.equal(getUnit(ready, 0).skill.sp, 5);
    const rng = createRng(ready.execution.rngState);
    rng.chance(0.3); rng.chance(0.3);
    assert.equal(executed.execution.rngState, rng.state());
    assert.equal(canMove(executed, getUnit(executed, 1)), false);
    assert.equal(canMove(executed, getUnit(executed, 2)), false);
    const expired = advance({ ...executed, tick: 18 });
    assert.equal(canMove(expired, getUnit(expired, 1)), true);
    assert.equal(canMove(expired, getUnit(expired, 2)), true);
});

test("S2 stays active through configured recovery and finishes on completion or cancellation", () => {
    for (const cancellation of [false, true]) {
        const fixture = setup({}, [enemy(1, [1, 0])], { recoveryTicks: 2 });
        let state = activateSkill(sp(fixture.state, 5), { unitId: 0, tick: 0, trigger: "AUTO" }, fixture.combat).state;
        state = start(state, unitRef(getUnit(state, 0)), fixture.action).state;
        assert.notEqual(getUnit(state, 0).skill.active, null);
        assert.equal(state.actions.size, 1);
        if (cancellation) {
            state = cancel({ ...state, tick: 1 }, { id: 0 });
        } else {
            state = advanceAction({ ...state, tick: 1 }, { id: 0 });
            assert.notEqual(getUnit(state, 0).skill.active, null);
            state = advanceAction({ ...state, tick: 2 }, { id: 0 });
        }
        assert.equal(getUnit(state, 0).skill.active, null);
        assert.equal(state.actions.size, 0);
        assert.equal(state.events.filter(event => event.type === "SKILL_FINISHED").length, 1);
        assert.equal(readShield(getUnit(state, 0)).layers, 1);
    }
});

test("Mudrock content explicitly rejects unsupported module Y, another character and invalid recovery", () => {
    const combat = new CombatResources();
    assert.throws(() => create(profile({ module: { id: "uniequip_003_mudrok", level: 3 } }), combat), /only module X/);
    assert.throws(() => create({ ...profile(), id: "char_208_melan" }, combat), /second skill/);
    assert.throws(() => create(profile(), combat, { recoveryTicks: -1 }), /nonnegative integer/);
});

test("an old S2 recovery cannot close a newer skill activation", () => {
    const fixture = setup({}, [enemy(1, [1, 0])], { recoveryTicks: 2 });
    let state = activateSkill(sp(fixture.state, 5), { unitId: 0, tick: 0, trigger: "AUTO" }, fixture.combat).state;
    state = start(state, unitRef(getUnit(state, 0)), fixture.action).state;
    assert.equal(getUnit(state, 0).skill.active.id, 0);
    state = finishSkill({ ...state, tick: 1 }, 0, 1, fixture.combat);
    assert.ok(getUnit(state, 0).effects.values().every(effect => effect.definition.id !== "mudrock/skill-attack"));
    state = activateSkill(sp(state, 5), { unitId: 0, tick: 1, trigger: "AUTO" }, fixture.combat).state;
    assert.equal(getUnit(state, 0).skill.active.id, 1);
    state = advanceAction(state, { id: 0 });
    const before = state;
    state = advanceAction({ ...state, tick: 2 }, { id: 0 });
    assert.equal(state.actions.size, 0);
    assert.equal(getUnit(state, 0).skill.active.id, 1);
    assert.equal(getUnit(before, 0).skill.active.id, 1);
    assert.deepEqual(state.events.filter(event => event.type === "SKILL_FINISHED").map(event => event.activationId), [0]);
});
