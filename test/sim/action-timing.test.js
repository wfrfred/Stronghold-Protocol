import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { battlefieldView, getUnit, updateUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { createActionCapabilityDefinition, createActionState } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { attackSpeed, baseAttackTime, computedAttackSpeed, computedBaseAttackTime } from "../../dist/core/tactical/unit/capability/action/contributions.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";
import { startAction } from "../../dist/core/tactical/unit/capability/action/execution.js";
import { createActionExecutionState } from "../../dist/core/tactical/unit/capability/action/process.js";
import { resolveAttackSpeed, resolveBaseAttackTime, resolveActionIntervalTicks } from "../../dist/core/tactical/unit/capability/action/timing.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { installNewEffect, setEffectEnabled, finishEffect, finalizeEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { copyUnitSnapshot } from "../../dist/core/tactical/unit/snapshot.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { createEnemyDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";
import { effectFixtureWork } from "../helpers/effects.js";

const geometry = createShapeGeometry({ shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 5 }] });
const address = { type: "EFFECT", unitId: 0, effectId: 0 };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

function actor(baseAttackTimeTicks = 30, recoveryTicks = 0) {
    return initializeUnit({
        id: 0, position: [0, 0],
        definition: {
            id: "timing-actor", vitality: { maxHp: 100 }, allegiance: { side: "ALLY" }, spatial: { layer: "GROUND" },
            action: createActionCapabilityDefinition({
                attackSpeed: 100,
                normalAction: {
                    baseAttackTimeTicks, recoveryTicks, triggerBindingId: "primary", followUps: [],
                    targetGroups: [{
                        id: "primary",
                        targeting: {
                            type: "DAMAGE", scope: { type: "RANGE", geometry: { type: "SHAPES", geometry } },
                            canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
                            ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1,
                        },
                        operations: [{ type: "DAMAGE", power: 1, damageType: "TRUE" }],
                    }],
                },
            }),
        },
    });
}

function target() {
    return initializeUnit({ id: 1, position: [1, 0], definition: {
        id: "timing-target", vitality: { maxHp: 1e6 }, allegiance: { side: "ENEMY" }, hit: { geometry }, spatial: { layer: "GROUND" },
    } });
}

function register(resources, speed = 100, time = modifier.create()) {
    return resources.registerEffect(createEffectProgram({
        id: "timing-buff", initialize: () => ({ speed, time }), ownState: (state) => ({ ...state }),
    }), { contributions: [
        attackSpeed((instance) => [modifier.create({ addition: instance.state.speed })]),
        baseAttackTime((instance) => [instance.state.time]),
    ] });
}

function install(work, program, resources, tick = 0, expiresAtTick = null) {
    installNewEffect(work, 0, program.ref, {
        source: null, scopes: expiresAtTick === null ? [] : [{ type: "TICK", tick: expiresAtTick }],
    }, resources, tick);
    return work;
}

function values(work, resources) {
    return valuesAt(battlefieldView(work), resources);
}

function valuesAt(battlefield, resources) {
    const unit = battlefield.getUnit(0);
    const evaluate = resources.computations.bind({ unit, battlefield });
    return [
        resolveAttackSpeed(unit.definition.action, unit.action, evaluate),
        resolveBaseAttackTime(unit.definition.action.normalAction, unit.action, evaluate),
        resolveActionIntervalTicks(unit.definition.action.normalAction, unit.definition.action, unit.action, evaluate),
    ];
}

function advance(work, resources, tick, state = createActionExecutionState(), compiled) {
    return startAction(
      work,
      state,
      {
        sourceUnitId: 0,
        compiled:
          compiled ??
          compileAction(getUnit(work, 0).definition.action.normalAction, resources),
        tick,
        mayStart: true,
      },
      resources,
    );
}

function spec(source, maxTicks) {
    const passive = createEnemyDefinition({ id: "keep-open", vitality: { maxHp: 1 }, locomotion: {
        moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
    } });
    return {
        ...createLegacyCombatSpec({ rows: 1, columns: 3, operators: [], enemies: [], maxTicks, seed: 17 }),
        initialUnits: [
            { definition: source.definition, position: source.position, states: { action: source.action, ...(source.effects === undefined ? {} : { effects: source.effects }) } },
            { definition: target().definition, position: [1, 0] },
        ],
        schedule: { type: "TIMELINE", spawns: [{ definition: passive, tick: maxTicks + 1,
            route: createRouteDefinition({ pathMotionMode: "WALK", startPosition: [0, 2], endPosition: [0, 0],
                spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false,
                visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true }),
            timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false,
        }] },
    };
}

test("action timing: ASPD attribute floor, interval cap and BAT algebra remain distinct", () => {
    const resources = new CombatResources();
    const program = register(resources, -200, modifier.create({ addition: -6, multiplier: 0.5, finalAddition: 3, finalScaler: 0.5 }));
    const initial = effectFixtureWork(actor(), target());
    const original = initial.battlefield.snapshot("draft");
    let work = install(initial, program, resources);
    assert.deepEqual(values(work, resources), [20, 19.5, 97.5]);
    updateEffectState(work, 0, 0, program.ref, (state) => ({ ...state, speed: 900 }), resources, 0);
    assert.deepEqual(values(work, resources), [1000, 19.5, 3.25]);
    updateEffectState(work, 0, 0, program.ref, (state) => ({ ...state, time: modifier.create({ addition: -100 }) }), resources, 0);
    assert.deepEqual(values(work, resources), [1000, 0, 1]);
    assert.deepEqual(valuesAt(original, resources), [100, 30, 30]);
});

test("action timing: lifecycle updates both slots and snapshots share only owned contributions", () => {
    const resources = new CombatResources();
    const program = register(resources, 100, modifier.create({ finalScaler: 0.5 }));
    const initial = effectFixtureWork(actor(), target());
    const installed = install(initial, program, resources);
    const installedSnapshot = installed.battlefield.snapshot("draft");
    assert.deepEqual(values(installed, resources), [200, 15, 7.5]);
    const copied = copyUnitSnapshot(getUnit(installed, 0));
    assert.equal(copied.action.attackSpeed.entries, getUnit(installed, 0).action.attackSpeed.entries);
    assert.ok(Object.isFrozen(copied.action.attackSpeed.entries));
    setEffectEnabled(installed, address, false, resources, 1);
    assert.deepEqual(values(installed, resources), [100, 30, 30]);
    setEffectEnabled(installed, address, true, resources, 2);
    assert.deepEqual(values(installed, resources), [200, 15, 7.5]);
    finishEffect(installed, address, resources, 3);
    assert.deepEqual(values(installed, resources), [100, 30, 30]);
    finalizeEffect(installed, address, resources, 3);
    assert.equal(getUnit(installed, 0).action.attackSpeed.entries.length, 0);
    assert.equal(getUnit(installed, 0).action.baseAttackTime.entries.length, 0);
    assert.equal(copied.action.attackSpeed.entries[0].participating, true);
    assert.deepEqual(valuesAt(installedSnapshot, resources), [200, 15, 7.5]);
});

test("action timing: speed-up and slow-down preserve completed cooldown percentage", () => {
    const resources = new CombatResources();
    const program = register(resources);
    const work = effectFixtureWork(actor(), target());
    const initial = advance(work, resources, 0);
    const initialSnapshot = work.battlefield.snapshot("draft");
    assert.equal(getUnit(work, 0).action.readyAtTick, 30);
    const installed = install(work, program, resources, 15);
    const spedUp = advance(installed, resources, 15, initial);
    close(getUnit(work, 0).action.readyAtTick, 22.5);
    assert.equal(work.events.filter((event) => event.type === "ACTION").length, 1);
    setEffectEnabled(work, address, false, resources, 18);
    const slowed = advance(work, resources, 18, spedUp);
    close(getUnit(work, 0).action.readyAtTick, 27);
    const beforeReady = advance(work, resources, 26, slowed);
    assert.equal(work.events.filter((event) => event.type === "ACTION").length, 1);
    const due = advance(work, resources, 27, beforeReady);
    assert.equal(work.events.filter((event) => event.type === "ACTION").length, 2);
    assert.equal(initialSnapshot.getUnit(0).action.readyAtTick, 30);
});

test("action timing: BAT changes adjust cooldown without rescaling recovery", () => {
    const resources = new CombatResources();
    const program = register(resources, 0, modifier.create({ finalScaler: 0.5 }));
    const work = effectFixtureWork(actor(30, 20), target());
    const initial = advance(work, resources, 0);
    const changed = advance(install(work, program, resources, 10), resources, 10, initial);
    assert.equal(getUnit(work, 0).action.readyAtTick, 20);
    assert.equal(getUnit(work, 0).action.recoveryUntilTick, 20);
    const due = advance(work, resources, 20, changed);
    assert.equal(getUnit(work, 0).action.readyAtTick, 35);
});

test("action timing: computed values read current facts rather than installation samples", () => {
    const resources = new CombatResources();
    const program = resources.registerEffect(createEffectProgram({ id: "live-timing", initialize: () => ({}), ownState: (state) => state }), {
        contributions: [
            computedAttackSpeed(({ unit }) => [modifier.create({ addition: unit.vitality.hp })]),
            computedBaseAttackTime(({ unit }) => [modifier.create({ addition: unit.vitality.hp / 10 })]),
        ],
    });
    const installed = install(effectFixtureWork(actor(), target()), program, resources);
    assert.deepEqual(values(installed, resources), [200, 40, 20]);
    const unit = getUnit(installed, 0);
    updateUnit(installed, { ...unit, vitality: { ...unit.vitality, hp: 50 } });
    assert.deepEqual(values(installed, resources), [150, 35, 35 / 1.5]);
});

test("action timing: delayed targeting resumes without accumulating missed attacks", () => {
    const resources = new CombatResources();
    const source = actor(4.5);
    const work = effectFixtureWork(source);
    const initial = advance(work, resources, 0);
    assert.equal(getUnit(work, 0), source);
    updateUnit(work, target());
    const resumed = advance(work, resources, 101, initial);
    assert.equal(getUnit(work, 0).action.readyAtTick, 105.5);
    const once = advance(work, resources, 101, resumed);
    assert.equal(work.events.filter((event) => event.type === "ACTION").length, 1);
});

test("action timing: a real 600 ASPD contribution preserves long-run fractional cadence at 30 Hz", () => {
    const resources = new CombatResources();
    const program = register(resources, 500);
    const installed = install(effectFixtureWork(actor(27), target()), program, resources);
    assert.deepEqual(values(installed, resources), [600, 27, 4.5]);
    const definition = spec(getUnit(installed, 0), 1200);
    const battle = new BattleRuntime(definition, { combat: resources });
    const reference = new BattleRuntime(definition, { combat: resources });
    const ticks = [];
    while (battle.result === null) {
        const stepped = battle.step();
        assert.deepEqual(stepped, reference.step());
        ticks.push(...stepped.events.filter((event) => event.type === "ACTION").map((event) => event.tick));
    }
    assert.equal(ticks.length, Math.ceil(1200 / 4.5));
    assert.deepEqual(ticks.slice(0, 8), [0, 5, 9, 14, 18, 23, 27, 32]);
    assert.deepEqual(battle.snapshot(), reference.snapshot());
    assert.equal(battle.snapshot().units.find((unit) => unit.id === 0).action.attackSpeed.entries.length, 1);
});

test("action timing: expiring a tempo Buff leaves accepted WAIT and recovery facts intact", () => {
    const resources = new CombatResources();
    const program = register(resources);
    const installed = install(effectFixtureWork(actor(30, 8), target()), program, resources, 0, 2);
    const battle = new BattleRuntime(spec(getUnit(installed, 0), 35), {
        combat: resources,
        compileAction: (definition, ports) => {
            const compiled = compileAction(definition, ports);
            return { ...compiled, program: [{ type: "WAIT", resolve: () => ({ type: "UNTIL_TICK", targetTick: 5 }) }, ...compiled.program] };
        },
    });
    battle.step();
    const accepted = battle.snapshot();
    assert.equal(accepted.units[0].action.readyAtTick, 15);
    assert.equal(accepted.units[0].action.recoveryUntilTick, 8);
    battle.step();
    battle.step();
    const expired = battle.snapshot();
    assert.equal(expired.units[0].action.readyAtTick, 28);
    assert.equal(expired.units[0].action.recoveryUntilTick, 8);
    assert.equal(expired.actionExecution.executions[0].wait.targetTick, 5);
    assert.equal(expired.actionExecution.executions[0].id, accepted.actionExecution.executions[0].id);
    const events = [];
    while (battle.snapshot().tickIndex <= 5) { events.push(...battle.step().events); }
    assert.equal(events.find((event) => event.type === "DAMAGE").tick, 5);
});

test("action timing: tick failure does not publish cooldown changes", () => {
    const resources = new CombatResources();
    const program = register(resources);
    const installed = install(effectFixtureWork(actor(), target()), program, resources, 0, 15);
    const fault = { enabled: false };
    const battle = new BattleRuntime(spec(getUnit(installed, 0), 40), {
        combat: resources,
        compileAction: (definition, ports) => {
            const compiled = compileAction(definition, ports);
            return { ...compiled, bind: (context) => {
                if (fault.enabled) { throw new Error("abort timing tick"); }
                return compiled.bind(context);
            } };
        },
    });
    battle.step();
    while (battle.snapshot().tickIndex < 15) { battle.step(); }
    const before = battle.snapshot();
    fault.enabled = true;
    assert.throws(() => battle.step(), /abort timing tick/);
    assert.deepEqual(battle.snapshot(), before);
});
