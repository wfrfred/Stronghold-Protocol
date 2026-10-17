import { damage as dealDamage, parameters } from "../helpers/vitality.js";
import { fixtureBattle, fixtureDefinition } from "../helpers/unit.js";
import { ref as activationRef } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import { healing } from "../helpers/vitality.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepare } from "../../dist/data/arknights/operator.js";
import { create, readShield } from "../../dist/content/tactical/operators/mudrock.js";

import { initialize } from "../helpers/unit.js";
import {
    createBattleState, battlefieldView, getUnit, updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { enterUnits } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { advance, end, get, install, replaceEffect } from "../../dist/core/tactical/unit/effect/operations.js";
import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import { setHook, removeHook } from "../../dist/core/tactical/battle/damage/hook.js";
import { activate as activateSkill, advance as advanceSkill, finish as finishSkill } from "../../dist/core/tactical/unit/capability/skill/operations.js";
import { start, cancel } from "../../dist/core/tactical/unit/action/operations.js";
import { advance as advanceAction } from "../../dist/core/tactical/unit/action/advance.js";
import { canMove } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { initialize as initializeTargetable, setRule as setTargetingRule } from "../../dist/core/tactical/unit/capability/targetable/capability.js";
import { invincible } from "../../dist/content/tactical/effects/protection.js";
import { setAttackContribution } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { setMaxHpContribution } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/attribute.js";
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
    id: `enemy-${id}`, targetable: {}, vitality: { maxHp: 10000 }, defense: { defense: 0, resistance: 0 },
    allegiance: { side: "ENEMY" }, spatial: { layer: "GROUND" },
    hit: { geometry: { shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.1 }] } },
    locomotion: { moveSpeedPerTick: 0.1, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } },
    ...fields,
} });
function setup(configuration = {}, targets = [], options = {}) {

    const prepared = profile(configuration);
    const content = create(prepared, options);
    const unit = initialize({ id: 0, position: [0, 0], definition: content.definition });
    const initial = createBattleState(fixtureBattlefieldState([unit, ...targets]));
    return { prepared, ...content, initial, state: enterUnits(initial, [0]) };
}
const save = (state, fields) => updateUnit(state, { ...getUnit(state, 0), ...fields });
const hp = (state, amount) => save(state, { vitality: { ...getUnit(state, 0).vitality, hp: amount } });
const sp = (state, amount) => save(state, { skill: { ...getUnit(state, 0).skill, sp: { ...getUnit(state, 0).skill.sp, value: amount } } });
const hit = (state, sourceUnitId = 1, power = 100) => dealDamage(state, { source: sourceUnitId === null ? null : { id: sourceUnitId }, target: { id: 0 }, parameters: parameters(power, "TRUE") });
const approximate = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const clearShield = (state) => hit(state).state;

test("entry installs one persistent shield container and preserves prior snapshots", () => {
    const { initial, state, prepared } = setup();
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
    const externalHealing = healing(hp(state, 1000), {
        source: null, target: { id: 0 }, parameters: { power: 100, multiplier: 1 },
    });
    assert.equal(externalHealing.value.kind, "APPLIED");
    assert.equal(externalHealing.value.application.hpGain, 100);
    assert.equal(getUnit(externalHealing.state, 0).vitality.hp, 1100);
    const enteredLate = enterUnits({ ...initial, tick: 100 }, [0]);
    assert.deepEqual(readShield(getUnit(advance({ ...enteredLate, tick: 101 }), 0)), { layers: 1, timer: 269 });
});

test("shield cancels damage, consumes a layer, self-heals and retains normal HIT recovery", () => {
    const fixture = setup({}, [enemy(1, [1, 0])]);
    const before = hp(fixture.state, 1000);
    const result = hit(before, 1, 5000);
    assert.equal(result.value.kind, "CANCELLED");
    assert.deepEqual(result.value.received.cancellation, { reason: "MUDROCK_SHIELD" });
    approximate(getUnit(result.state, 0).vitality.hp, 1000 + fixture.prepared.attributes.maxHp * 0.2);
    assert.equal(getUnit(result.state, 0).skill.sp.value, 1);
    assert.deepEqual(readShield(getUnit(result.state, 0)), { layers: 0, timer: 270 });
    assert.equal(getUnit(result.state, 0).effects.values().find(instance => instance.definition.id === "mudrock/shield").status, "ACTIVE");
    assert.equal(getUnit(before, 0).vitality.hp, 1000);
    assert.deepEqual(readShield(getUnit(before, 0)), { layers: 1, timer: 270 });
    const external = healing(result.state, {
        source: { id: 1 }, target: { id: 0 }, parameters: { power: 1000, multiplier: 1 },
    });
    assert.equal(external.value.kind, "APPLIED");
    assert.equal(external.value.application.hpGain, 1000);
    assert.equal(getUnit(external.state, 0).vitality.hp, getUnit(result.state, 0).vitality.hp + 1000);
    const unshielded = hit(result.state);
    assert.equal(unshielded.value.application.hpLoss, 100);
});

test("an earlier barrier exhausts its budget without consuming Mudrock's shield or triggering its recovery", () => {
    const fixture = setup({ potential: 6, module: { id: moduleX, level: 3 } }, [enemy(1, [1, 0])]);
    const barrier = {
        id: "test/barrier",
        initialize: () => ({ remaining: 5000 }),
        onEnable: (state, { unit, self, ref }) => updateUnit(state, {
            ...unit,
            vitality: setHook(unit.vitality, {
                id: `barrier/${self.id}`,
                stage: "receiving",
                priority: 200,
                accepts: (_state, _context, pending) => pending.cancellation === null && pending.amount > 0,
                invoke(state, _context, pending) {
                    const current = get(state, ref);
                    const absorbed = Math.min(current.data.remaining, pending.amount);
                    const remaining = current.data.remaining - absorbed;
                    state = replaceEffect(state, ref, setData(current, { remaining }));
                    if (remaining === 0) state = end(state, ref);
                    return { state, value: { ...pending, amount: pending.amount - absorbed } };
                },
            }),
        }),
        onDisable: (state, { unit, self }) => updateUnit(state, {
            ...unit, vitality: removeHook(unit.vitality, `barrier/${self.id}`),
        }),
    };
    const wounded = hp(fixture.state, 1000);
    const installed = install(wounded, unitRef(getUnit(wounded, 0)), barrier);
    const result = hit(installed.state, 1, 5000);
    assert.equal(result.value.kind, "APPLIED");
    assert.equal(result.value.received.amount, 0);
    assert.equal(result.value.application.hpLoss, 0);
    assert.equal(getUnit(result.state, 0).vitality.hp, 1000);
    assert.equal(getUnit(result.state, 0).skill.sp.value, 1);
    assert.deepEqual(readShield(getUnit(result.state, 0)), { layers: 1, timer: 270 });
    assert.equal(result.state.events.filter(event => event.type === "HEAL").length, 0);
    assert.equal(get(result.state, installed.value), undefined);
    const next = hit(result.state);
    assert.equal(next.value.kind, "CANCELLED");
    assert.equal(readShield(getUnit(next.state, 0)).layers, 0);
    assert.equal(getUnit(next.state, 0).skill.sp.value, 4);
    approximate(getUnit(next.state, 0).vitality.hp, 1000 + fixture.prepared.attributes.maxHp * 0.25);
});

test("invincible reception leaves shield untouched and removing its effect removes the hook", () => {
    const fixture = setup({}, [enemy(1, [1, 0])]);
    const protectedState = install(fixture.state, unitRef(getUnit(fixture.state, 0)), invincible).state;
    const canceled = hit(protectedState);
    assert.equal(canceled.value.kind, "REJECTED");
    assert.equal(readShield(getUnit(canceled.state, 0)).layers, 1);
    const effect = getUnit(fixture.state, 0).effects.values().find(instance => instance.definition.id === "mudrock/shield");
    const removed = end(fixture.state, { host: { id: 0 }, id: effect.id });
    assert.equal(readShield(getUnit(removed, 0)), undefined);
    assert.equal(hit(removed).value.application.hpLoss, 100);
});

test("shield recharge keeps its periodic clock while capped and zero layers remain installed", () => {
    const fixture = setup({}, [enemy(1, [1, 0])]);
    let state = clearShield(fixture.state);
    state = advance({ ...state, tick: 269 });
    assert.deepEqual(readShield(getUnit(state, 0)), { layers: 0, timer: 1 });
    state = advance({ ...state, tick: 270 });
    assert.deepEqual(readShield(getUnit(state, 0)), { layers: 1, timer: 270 });
    state = advance({ ...state, tick: 1000 });
    assert.deepEqual(readShield(getUnit(state, 0)), { layers: 3, timer: 80 });
    state = hit(state).state;
    state = advance({ ...state, tick: 1080 });
    assert.deepEqual(readShield(getUnit(state, 0)), { layers: 3, timer: 270 });
    assert.equal(getUnit(state, 0).effects.values().filter(instance => instance.definition.id === "mudrock/shield").length, 1);
    const e1 = setup({ elite: 1, level: 80 });
    assert.equal(readShield(getUnit(advance({ ...e1.state, tick: 810 }), 0)).layers, 2);
});

test("module X healing and bonus SP use the selected talent and dynamic max HP", () => {
    const fixture = setup({ potential: 6, module: { id: moduleX, level: 3 } }, [enemy(1, [0.6, 0], { blockable: { volume: 1 } })]);
    let state = hp(fixture.state, 1000);
    state = save(state, { vitality: setMaxHpContribution(getUnit(state, 0).definition.vitality, getUnit(state, 0).vitality, {
        id: "test/max-hp", value: [modifier({ addition: 1000 })],
    }) });
    state = hp(state, 1000);
    const result = hit(state);
    approximate(getUnit(result.state, 0).vitality.hp, 1000 + (fixture.prepared.attributes.maxHp + 1000) * 0.25);
    assert.equal(getUnit(result.state, 0).skill.sp.value, 3);
    assert.deepEqual(battlefieldView(result.state).blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);
    assert.equal(hit(result.state).value.application.hpLoss, 85);
});

test("Sarkaz resistance and module blocked-source reduction compose only for their source conditions", () => {
    const fixture = setup({ module: { id: moduleX, level: 1 } }, [
        enemy(1, [0.6, 0], { blockable: { volume: 1 }, profile: { tags: ["sarkaz"] } }),
        enemy(2, [5, 0], { profile: { tags: ["sarkaz"] } }),
        enemy(3, [6, 0]),
    ]);
    const state = clearShield(fixture.state);
    approximate(hit(state, 1).value.application.hpLoss, 59.5);
    approximate(hit(state, 2).value.application.hpLoss, 70);
    approximate(hit(state, 3).value.application.hpLoss, 100);
    approximate(hit(state, null).value.application.hpLoss, 100);
    const e1 = setup({ elite: 1, level: 80 }, [enemy(1, [1, 0], { profile: { tags: ["sarkaz"] } })]);
    assert.equal(hit(clearShield(e1.state)).value.application.hpLoss, 100);
});

test("S2 does not consume SP without an eligible ground target in its range", () => {
    for (const receiver of [enemy(1, [5, 0]), enemy(1, [1, 0], { spatial: { layer: "AIR" } }),
        { ...enemy(1, [1, 0]), targetable: setTargetingRule(initializeTargetable(fixtureBattle(0), fixtureDefinition("targetable")).value, {
            id: "not-selectable", allows: () => false,
        }) }]) {
        const fixture = setup({}, [receiver]);
        const ready = sp(fixture.state, 5);
        const result = activateSkill({ ...ready, tick: 0 }, unitRef(getUnit(ready, 0)), "AUTO" );
        assert.deepEqual(result.value, { type: "REJECTED", reason: "CONDITION" });
        assert.equal(getUnit(result.state, 0).skill.sp.value, 5);
        assert.equal(getUnit(result.state, 0).skill.active, null);
        assert.equal(result.state.events.some(event => event.type === "SKILL_ACTIVATED"), false);
    }
});

test("S2 immediately overrides normal attack and recovery cooldown, heals once, hits all eligible targets and finishes", () => {
    const fixture = setup({}, [enemy(1, [1, 0]), enemy(2, [0.8, 0]),
        enemy(3, [1, 0], { spatial: { layer: "AIR" } }), enemy(4, [5, 0])]);
    let ready = sp(hp(fixture.state, 1000), 5);
    ready = save(ready, {
        action: { ...getUnit(ready, 0).action, states: new Map(
            [...getUnit(ready, 0).action.states].map(([id, current]) => [id, {
                ...current, cooldown: { readyAtTick: 10000, periodTicks: 60 },
            }]),
        ) },
        offense: setAttackContribution(getUnit(ready, 0).offense, { id: "test/attack", value: [modifier({ addition: 100 })] }),
    });
    const active = advanceSkill({ ...ready, tick: 0 }, unitRef(getUnit(ready, 0)));
    assert.equal(getUnit(active, 0).skill.active.sustain.type, "INFINITE");
    assert.equal(getUnit(active, 0).action.states.get("normal-attack").cooldown.readyAtTick, 0);
    assert.equal(getUnit(active, 0).action.states.get(fixture.action.id).cooldown.readyAtTick, 0);
    assert.deepEqual(fixture.definition.action.select(active, getUnit(active, 0)).value, [fixture.action.id]);
    const executed = start(active, unitRef(getUnit(active, 0)), fixture.action).state;
    const amount = (fixture.prepared.attributes.attack + 100) * 2.1;
    approximate(getUnit(executed, 1).vitality.hp, 10000 - amount);
    approximate(getUnit(executed, 2).vitality.hp, 10000 - amount);
    assert.equal(getUnit(executed, 3).vitality.hp, 10000);
    assert.equal(getUnit(executed, 4).vitality.hp, 10000);
    approximate(getUnit(executed, 0).vitality.hp, 1000 + fixture.prepared.attributes.maxHp * 0.05);
    assert.equal(getUnit(executed, 0).skill.active, null);
    assert.equal(getUnit(executed, 0).skill.sp.value, 0);
    assert.equal(executed.events.filter(event => event.type === "HEAL").length, 1);
    assert.equal(executed.events.filter(event => event.type === "DAMAGE").length, 2);
    assert.equal(executed.events.filter(event => event.type === "SKILL_FINISHED").length, 1);
    assert.equal(getUnit(active, 1).vitality.hp, 10000);
    assert.equal(getUnit(ready, 0).skill.sp.value, 5);
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
        let state = activateSkill({ ...sp(fixture.state, 5), tick: 0 }, unitRef(getUnit(sp(fixture.state, 5), 0)), "AUTO" ).state;
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

    assert.throws(() => create(profile({ module: { id: "uniequip_003_mudrok", level: 3 } })), /only module X/);
    assert.throws(() => create({ ...profile(), id: "char_208_melan" }), /second skill/);
    assert.throws(() => create(profile(), { recoveryTicks: -1 }), /nonnegative integer/);
});

test("an old S2 recovery cannot close a newer skill activation", () => {
    const fixture = setup({}, [enemy(1, [1, 0])], { recoveryTicks: 2 });
    let state = activateSkill({ ...sp(fixture.state, 5), tick: 0 }, unitRef(getUnit(sp(fixture.state, 5), 0)), "AUTO" ).state;
    state = start(state, unitRef(getUnit(state, 0)), fixture.action).state;
    assert.equal(getUnit(state, 0).skill.active.id, 0);
    state = finishSkill({ ...{ ...state, tick: 1 }, tick: 1 }, activationRef(getUnit({ ...state, tick: 1 }, 0).skill.active));
    assert.ok(getUnit(state, 0).effects.values().every(effect => effect.definition.id !== "mudrock/skill-attack"));
    state = activateSkill({ ...sp(state, 5), tick: 1 }, unitRef(getUnit(sp(state, 5), 0)), "AUTO" ).state;
    assert.equal(getUnit(state, 0).skill.active.id, 1);
    state = advanceAction(state, { id: 0 });
    const before = state;
    state = advanceAction({ ...state, tick: 2 }, { id: 0 });
    assert.equal(state.actions.size, 0);
    assert.equal(getUnit(state, 0).skill.active.id, 1);
    assert.equal(getUnit(before, 0).skill.active.id, 1);
    assert.deepEqual(state.events.filter(event => event.type === "SKILL_FINISHED").map(event => event.activationId), [0]);
});
