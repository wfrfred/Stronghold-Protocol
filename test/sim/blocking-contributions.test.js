import { fixtureBattlefield } from "../helpers/battlefield.js";
import { deadline } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
    createBattleState,
    battlefieldView,
    getUnit,
} from "../../dist/core/tactical/battle/execution/context.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { projectStaticNavigationMap } from "../../dist/core/tactical/battlefield/navigation/projection.js";
import { applyBattlefieldChanges } from "../../dist/core/tactical/battlefield/storage/changes.js";
import { deriveBattlefieldDependencies } from "../../dist/core/tactical/battlefield/storage/dependencies.js";
import {
    createBattlefieldState,
    settleBattlefieldState,
    settleBattlefieldStateFully,
} from "../../dist/core/tactical/battlefield/storage/state.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { copyUnitSnapshot } from "../../dist/core/tactical/unit/snapshot.js";
import {
    createBlockerDefinition,
    initializeBlockerState,
    resolveBlockingCapacity,
    setCapacityContribution,
    removeCapacityContribution,
} from "../../dist/core/tactical/unit/capability/blocking/capability.js";

import * as effects from "../../dist/core/tactical/unit/effect/operations.js";

import { resolveMaxHp } from "../../dist/core/tactical/unit/capability/vitality/query.js";
import * as contribution from "../../dist/core/tactical/unit/contribution/contribution.js";
import * as modifier from "../../dist/core/tactical/unit/contribution/value.js";
import {
    compileAttributeModifiers,
    parseAttributeModifiers,
} from "../../dist/data/arknights/modifier.js";
import { compileBuffStacking, parseBuffStacking } from "../../dist/data/arknights/buff-stacking.js";
import {
    contributionEffect,
    refreshContribution,
    maxHpBuff,
    at,
    effectFixtureWork,
} from "../helpers/effects.js";

const fixtures = JSON.parse(
    readFileSync(new URL("../fixtures/arknights/blocking_buffs.json", import.meta.url), "utf8"),
);
const fixture = (key) => fixtures.find((entry) => entry.node._buff.buffKey === key);
const effectAddress = { type: "EFFECT", unitId: 0, effectId: 0 };

const blocker = (capacity = 3) =>
    initializeUnit({
        id: 0,
        position: [0, 0],
        definition: {
            id: "capacity-holder",
            allegiance: { side: "ALLY" },
            vitality: { maxHp: 100 },
            blocker: { capacity, geometry: { radius: 1 } },
        },
    });
const enemy = (id, weight = 1) =>
    initializeUnit({
        id,
        position: [0.25, 0],
        definition: {
            id: `blocked-${id}`,
            allegiance: { side: "ENEMY" },
            blockable: { weight },
        },
    });
const capacityOf = (unit) => resolveBlockingCapacity(unit.definition.blocker, unit.blocker);
const capacity = (work) => capacityOf(getUnit(work, 0));
const output = (value) => ({
    set: setCapacityContribution,
    remove: removeCapacityContribution,
    value,
});
const install = (work, effect, expiresAtTick = null) =>
    effects.apply(work, getUnit(work, 0), effect, {
        source: 7,
        scopes: expiresAtTick === null ? [] : [{ type: "TICK", tick: expiresAtTick }],
    });
const change = (work, effect, next, setting) => {
    effects.setState(work, effectAddress, effect, next);
    refreshContribution(work, effectAddress, effect, setting);
};
const entry = (id, value) => ({ id, value: [value] });

test("blocking capacity: immutable updates retain sampled contributions and resolve ties to even after clamping", () => {
    const definition = createBlockerDefinition({ capacity: 3, geometry: { radius: 1 } });
    const state = initializeBlockerState(definition);
    assert.equal(definition.capacity, 3);
    assert.deepEqual(state.capacity, []);
    assert.equal(resolveBlockingCapacity(definition, state), 3);
    const modified = {
        ...state,
        capacity: contribution.set(
            [],
            entry(
                "arithmetic",
                modifier.create({
                    addition: 1,
                    multiplier: 0.5,
                    finalAddition: 1,
                    finalScaler: 2,
                }),
            ),
        ),
    };
    assert.equal(resolveBlockingCapacity(definition, modified), 14);
    const disabled = {
        ...modified,
        capacity: contribution.remove(modified.capacity, "arithmetic"),
    };
    assert.deepEqual(disabled.capacity, []);
    assert.equal(resolveBlockingCapacity(definition, disabled), 3);
    assert.equal(resolveBlockingCapacity(definition, modified), 14);
    for (const [value, expected] of [
        [-3, 0],
        [-0.5, 0],
        [0.49, 0],
        [0.5, 0],
        [0.51, 1],
        [1.5, 2],
        [2.5, 2],
        [3.5, 4],
    ]) {
        const result = {
            ...state,
            capacity: contribution.set(
                [],
                entry("rounding", modifier.create({ finalAddition: value - 3 })),
            ),
        };
        assert.equal(resolveBlockingCapacity(definition, result), expected, `resolved ${value}`);
    }
});

test("blocking capacity: explicit refresh and lifecycle output changes preserve base capacity and unrelated HP", () => {
    const setting = output((instance) => [modifier.create({ addition: instance.state.amount })]);
    const effect = contributionEffect("capacity", { amount: -1 }, setting);
    const initialized = blocker();
    const owner = { ...initialized, vitality: { ...initialized.vitality, hp: 50 } };
    const work = effectFixtureWork(owner);
    install(work, effect);
    const old = getUnit(work, 0);
    assert.equal(capacity(work), 2);
    change(work, effect, { amount: -2 }, setting);
    assert.equal(capacity(work), 1);
    effects.setEnabled(work, effectAddress, false);
    assert.equal(capacity(work), 3);
    change(work, effect, { amount: -9 }, setting);
    assert.equal(capacity(work), 3);
    effects.setEnabled(work, effectAddress, true);
    assert.equal(capacity(work), 0);
    effects.apply(work, getUnit(work, 0), maxHpBuff("hp", 100));
    assert.equal(getUnit(work, 0).vitality.hp, 100);
    effects.end(work, effectAddress);
    assert.equal(capacity(work), 3);
    assert.equal(getUnit(work, 0).vitality.hp, 100);
    assert.equal(old.blocker.capacity.length, 1);
    assert.equal(capacityOf(old), 2);
});

function battlefield(units) {
    const tile = createTile({
        heightType: "LOWLAND",
        buildableType: "ALL",
        passableMask: "ALL",
        playerSideMask: "ALL",
        terrain: "NORMAL",
        mechanism: null,
    });
    const map = createBattlefieldMap(1, 1, [tile]);
    const baseline = {
        WALK: projectStaticNavigationMap(map, "WALK", 0),
        FLY: projectStaticNavigationMap(map, "FLY", 0),
    };
    const branches = [settleBattlefieldState, settleBattlefieldStateFully].map((settle) => ({
        settle,
        state: createBattlefieldState(map, baseline),
    }));
    const commit = (changes) => {
        const results = branches.map((branch) => {
            const previous = branch.state;
            const applied = applyBattlefieldChanges(previous, changes);
            const dependencies = deriveBattlefieldDependencies(
                map,
                previous,
                applied.content,
                applied.dependencies,
            );
            const settled = branch.settle(
                map,
                baseline,
                previous,
                applied.content,
                applied.dependencies,
            );
            branch.state = settled.state;
            return { ...applied.facts, ...settled.facts, dependencies };
        });
        assert.deepEqual(results[0], results[1]);
        assert.deepEqual(branches[0].state, branches[1].state);
        return results[0];
    };
    const h = {
        branches,
        commit,
        get state() {
            return branches[0].state;
        },
        work() {
            return createBattleState(
                fixtureBattlefield({
                    map,
                    unitIds: [...h.state.units.keys()],
                    getUnit: (id) => h.state.units.get(id),
                    blockingRelations: h.state.blockingRelations,
                    supportRelations: h.state.supportRelations,
                }),
            );
        },
        publish(work) {
            return commit(
                work.battlefield
                    .snapshot("draft")
                    .unitIds.map((id) => ({ type: "UPDATE_UNIT", unit: getUnit(work, id) })),
            );
        },
        blocked() {
            return h.state.blockingRelations.map((relation) => relation.blockedUnitId);
        },
    };
    commit(units.map((unit) => ({ type: "REGISTER_UNIT", unit })));
    return h;
}

function nativeModifier(raw) {
    const description = raw.node._buff.attributes.attributeModifiers.find(
        (value) => value.attributeType === "BLOCK_CNT",
    );
    const parsed = parseAttributeModifiers([description]);
    assert.deepEqual(parseAttributeModifiers([{ ...description, attributeType: 5 }]), parsed);
    return compileAttributeModifiers(parsed)[0];
}

test("blocking capacity: native stack renewal and terminal cleanup update real blocking relationships", () => {
    const raw = fixture("enemy_mcnist_block_cnt_advance");
    const rule = compileBuffStacking(parseBuffStacking(raw.node._buff));
    const compiled = nativeModifier(raw);
    const setting = output((instance) => [
        compiled.sample({
            blackboard: new Map([["block_cnt", -1]]),
            stackCount: rule.validStackCount(instance.state.stackCount),
            readSourceAttribute: () => undefined,
        }),
    ]);
    let content;
    content = contributionEffect(
        raw.node._buff.buffKey,
        { stackCount: 3, lifetimeTicks: 2 },
        setting,
        {
            onTick(ctx) {
                if (ctx.tick < deadline(ctx.self)) return;
                const plan = rule.expire(
                    { stackCount: ctx.self.state.stackCount, expiresAtTick: deadline(ctx.self) },
                    ctx.self.state.lifetimeTicks,
                    ctx.tick,
                );
                if (plan.type === "FINISH") ctx.end();
                else {
                    effects.setTick(ctx.battle, ctx.ref, plan.expiresAtTick);
                    ctx.setState((state) => ({ ...state, stackCount: plan.stackCount }));
                    refreshContribution(ctx.battle, ctx.ref, content, setting);
                }
            },
        },
    );
    const h = battlefield([blocker(), enemy(1), enemy(2), enemy(3), enemy(4, 4)]);
    const original = h.state;
    const work = h.work();
    install(work, content, 2);
    h.publish(work);
    assert.deepEqual(h.blocked(), []);
    for (const [tick, remaining] of [
        [2, 1],
        [4, 2],
        [6, 3],
    ]) {
        const work = h.work();
        effects.advance(at(work, tick));
        h.publish(work);
        assert.equal(capacityOf(h.state.units.get(0)), remaining);
        assert.deepEqual(
            h.blocked(),
            Array.from({ length: remaining }, (_, index) => index + 1),
        );
    }
    assert.deepEqual(h.state.units.get(0).effects.instances, []);
    assert.equal(original.units.get(0).blocker.capacity.length, 0);
});

test("blocking capacity: native zero scaler releases weighted targets and restores capacity independently of their weight", () => {
    const raw = fixture("redace[taunt]");
    const compiled = nativeModifier(raw);
    const setting = output(() => [
        compiled.sample({
            blackboard: new Map(),
            stackCount: 1,
            readSourceAttribute: () => undefined,
        }),
    ]);
    const content = contributionEffect(raw.node._buff.buffKey, {}, setting);
    const h = battlefield([blocker(), enemy(1, 2), enemy(2), enemy(3, 4)]);
    assert.deepEqual(h.blocked(), [1, 2]);
    const work = h.work();
    install(work, content);
    h.publish(work);
    assert.deepEqual(h.blocked(), []);
    const paused = h.work();
    effects.setEnabled(paused, effectAddress, false);
    h.publish(paused);
    assert.deepEqual(h.blocked(), [1, 2]);
    const resumed = h.work();
    effects.setEnabled(resumed, effectAddress, true);
    h.publish(resumed);
    assert.deepEqual(h.blocked(), []);
    const finished = h.work();
    effects.end(finished, effectAddress);
    h.publish(finished);
    assert.deepEqual(h.blocked(), [1, 2]);
    assert.deepEqual(
        [...h.state.units.values()].slice(1).map((unit) => unit.blockable.weight),
        [2, 1, 4],
    );
});

test("blocking capacity: replacing contribution entries without changing the resolved number leaves projection clean", () => {
    const h = battlefield([blocker(), enemy(1)]);
    const before = h.state;
    const owner = before.units.get(0);
    const changed = setCapacityContribution(
        setCapacityContribution(owner, entry("positive", modifier.create({ addition: 1 }))),
        entry("negative", modifier.create({ addition: -1 })),
    );
    assert.notEqual(changed.blocker.capacity, owner.blocker.capacity);
    assert.equal(capacityOf(changed), capacityOf(owner));
    const result = h.commit([{ type: "UPDATE_UNIT", unit: changed }]);
    assert.deepEqual(result.dependencies, {
        unitTiles: false,
        occupancy: false,
        support: false,
        blocking: false,
        navigationModifierRelations: false,
        navigationModifierCoverage: false,
    });
    assert.equal(h.state.blockingRelations, before.blockingRelations);
    assert.equal(h.state.spatial, before.spatial);
    assert.equal(h.state.navigationMaps, before.navigationMaps);
    const refreshed = setCapacityContribution(
        h.state.units.get(0),
        entry("positive", modifier.create({ addition: 1.1 })),
    );
    assert.equal(capacityOf(refreshed), 3);
    assert.equal(h.commit([{ type: "UPDATE_UNIT", unit: refreshed }]).dependencies.blocking, false);
});
