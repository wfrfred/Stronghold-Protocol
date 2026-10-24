import { ref as effectRef } from "../../dist/core/tactical/unit/effect/effect.js";
import { view } from "../../dist/core/tactical/battlefield/view.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fixtureBattle, initialize } from "../helpers/unit.js";
import { fixture as blockingFixture, acquire, blockedIds } from "../helpers/blocking.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { deadline, setDeadline } from "../../dist/core/tactical/unit/effect/effect.js";
import { getUnit, registerUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { usedCapacity } from "../../dist/core/tactical/battle/blocking/query.js";
import {
    initialize as initializeBlockerState,
    resolveCapacity,
    setCapacityContribution,
    removeCapacityContribution,
} from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import {
    canBeBlocked, resolveVolume, setVolumeContribution, removeVolumeContribution, setRule, removeRule,
} from "../../dist/core/tactical/unit/capability/blocking/blockable.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import * as contribution from "../../dist/core/tactical/unit/contribution/contribution.js";
import * as modifier from "../../dist/core/tactical/unit/contribution/attribute.js";
import { compileAttributeModifiers, parseAttributeModifiers } from "../../dist/data/arknights/modifier.js";
import { compileBuffStacking, parseBuffStacking } from "../../dist/data/arknights/buff-stacking.js";
import {
    contributionEffect, refreshContribution, maxHpBuff, at, effectFixtureWork, replaceEffectFixture,
} from "../helpers/effects.js";

const fixtures = JSON.parse(
    readFileSync(new URL("../fixtures/arknights/blocking_buffs.json", import.meta.url), "utf8"),
);
const fixture = (key) => fixtures.find((entry) => entry.node._buff.buffKey === key);
const effectAddress = { host: { id: 0 }, id: 0 };

const blocker = (capacity = 3) =>
    initialize({
        id: 0,
        position: [0, 0],
        definition: {
            id: "capacity-holder",
            allegiance: { side: "ALLY" },
            vitality: { maxHp: 100, defense: 0, resistance: 0 },
            blocker: { capacity, geometry: { radius: 1 } },
        },
    });
const enemy = (id, volume = 1) =>
    initialize({
        id,
        position: [0.25, 0],
        definition: {
            id: `blocked-${id}`,
            allegiance: { side: "ENEMY" },
            blockable: { volume },
        },
    });
const capacityOf = (unit) => resolveCapacity(unit.definition.blocker, unit.blocker);
const capacity = (work) => capacityOf(getUnit(work, 0));
const output = (value) => ({
    capability: "blocker", set: setCapacityContribution,
    remove: removeCapacityContribution,
    value,
});
const install = (work, effect, expiresAtTick = null) =>
    effects.install(work, unitRef(getUnit(work, 0)), effect, {
        source: 7,
        scopes: expiresAtTick === null ? [] : [{ type: "TICK", tick: expiresAtTick }],
    });
const change = (work, effect, next, setting) => {
    work = effects.update(work, effectAddress, data => ({ ...data, ...next }));
    return refreshContribution(work, effectAddress, effect, setting);
};
const entry = (id, value) => ({ id, value: [value] });

test("blocking initialization accepts plain definitions and validates them through unit initialization", () => {
    const geometry = { radius: 1 };
    const definition = { id: "both", blocker: { capacity: 3, geometry }, blockable: { volume: 2 } };
    const unit = initialize({ id: 0, position: [0, 0], definition });
    assert.equal(unit.definition, definition);
    assert.equal(unit.blocker.geometry, geometry);
    assert.deepEqual(unit.blocker, { capacity: [], geometry, rules: [], blocked: [], acquired: [], released: [] });
    assert.deepEqual(unit.blockable, { volume: [], rules: [], blocker: null, acquired: [], released: [] });
    for (const [capability, invalid] of [
        ["blocker", { capacity: -1, geometry }],
        ["blocker", { capacity: 1.5, geometry }],
        ["blocker", { capacity: 1, geometry: { radius: -1 } }],
        ["blockable", { volume: 0 }],
        ["blockable", { volume: 1.5 }],
    ]) {
        assert.throws(() => initialize({
            id: 0, position: [0, 0], definition: { id: "invalid", [capability]: invalid },
        }), RangeError);
    }
});

test("blocking capacity: immutable updates retain sampled contributions and resolve ties to even after clamping", () => {
    const definition = { capacity: 3, geometry: { radius: 1 } };
    const state = initializeBlockerState(fixtureBattle(0), definition).value;
    assert.equal(definition.capacity, 3);
    assert.deepEqual(state.capacity, []);
    assert.equal(resolveCapacity(definition, state), 3);
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
    assert.equal(resolveCapacity(definition, modified), 14);
    const disabled = {
        ...modified,
        capacity: contribution.remove(modified.capacity, "arithmetic"),
    };
    assert.deepEqual(disabled.capacity, []);
    assert.equal(resolveCapacity(definition, disabled), 3);
    assert.equal(resolveCapacity(definition, modified), 14);
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
        assert.equal(resolveCapacity(definition, result), expected, `resolved ${value}`);
    }
});

test("blocking capacity: explicit refresh and lifecycle output changes preserve base capacity and unrelated HP", () => {
    const setting = output((instance) => [modifier.create({ addition: instance.data.amount })]);
    const effect = contributionEffect("capacity", { amount: -1 }, setting);
    const initialized = blocker();
    const owner = { ...initialized, vitality: { ...initialized.vitality, hp: 50 } };
    let work = effectFixtureWork(owner);
    work = install(work, effect).state;
    const old = getUnit(work, 0);
    assert.equal(capacity(work), 2);
    work = change(work, effect, { amount: -2 }, setting);
    assert.equal(capacity(work), 1);
    work = effects.setEnabled(work, effectAddress, false);
    assert.equal(capacity(work), 3);
    work = change(work, effect, { amount: -9 }, setting);
    assert.equal(capacity(work), 3);
    work = effects.setEnabled(work, effectAddress, true);
    assert.equal(capacity(work), 0);
    work = effects.install(work, unitRef(getUnit(work, 0)), maxHpBuff("hp", 100)).state;
    assert.equal(getUnit(work, 0).vitality.hp, 100);
    work = effects.end(work, effectAddress);
    assert.equal(capacity(work), 3);
    assert.equal(getUnit(work, 0).vitality.hp, 100);
    assert.equal(old.blocker.capacity.length, 1);
    assert.equal(capacityOf(old), 2);
});

function battlefield(units) {
    let battle = acquire(blockingFixture(units), 0);
    return {
        get state() { return battle.battlefield; },
        work() { return battle; },
        publish(next) { battle = next; },
        search() { battle = acquire(battle, 0); },
        commit(transform) {
            const content = transform(battle.battlefield);
            for (const [id, unit] of content.units) {
                if (getUnit(battle, id) === undefined) battle = registerUnit(battle, unit);
                else if (getUnit(battle, id) !== unit) battle = updateUnit(battle, unit);
            }
        },
        blocked() { return blockedIds(battle, 0); },
    };
}

test("blocking volume: independent Effect contributions release targets and clean up by source", () => {
    const h = battlefield([blocker(), enemy(1), enemy(2)]);
    const original = h.state;
    const setting = {
        capability: "blockable", set: setVolumeContribution, remove: removeVolumeContribution,
        value: () => 1,
    };
    const first = contributionEffect("larger-a", {}, setting);
    const second = contributionEffect("larger-b", {}, setting);
    let result = effects.install(h.work(), unitRef(h.state.units.get(1)), first);
    h.publish(result.state);
    const firstRef = result.value;
    assert.deepEqual(h.blocked(), [1, 2]);
    result = effects.install(h.work(), unitRef(h.state.units.get(1)), second);
    h.publish(result.state);
    const secondRef = result.value;
    const expanded = h.state.units.get(1);
    assert.equal(resolveVolume(expanded.definition.blockable, expanded.blockable), 3);
    assert.deepEqual(h.blocked(), [1]);
    assert.equal(usedCapacity(h.work(), { id: 0 }), 3);

    h.publish(effects.end(h.work(), firstRef));
    assert.deepEqual(h.blocked(), [1]);
    h.search();
    assert.deepEqual(h.blocked(), [1, 2]);
    h.publish(effects.setEnabled(h.work(), secondRef, false));
    assert.equal(resolveVolume(h.state.units.get(1).definition.blockable, h.state.units.get(1).blockable), 1);
    h.publish(effects.setEnabled(h.work(), secondRef, true));
    assert.equal(resolveVolume(h.state.units.get(1).definition.blockable, h.state.units.get(1).blockable), 2);
    h.publish(effects.end(h.work(), secondRef));
    const current = h.state.units.get(1);
    assert.deepEqual(current.blockable.volume, []);
    assert.equal(current.definition.blockable.volume, 1);
    assert.equal(current.definition, expanded.definition);
    assert.equal(resolveVolume(expanded.definition.blockable, expanded.blockable), 3);
    assert.deepEqual(original.units.get(1).blockable.volume, []);
});

test("blocking volume: integer additions honor exclusive groups and restore the remaining candidate", () => {
    const h = battlefield([blocker(4), enemy(1), enemy(2)]);
    const original = h.state.units.get(1);
    const replace = (blockableState) => {
        const battle = h.work();
        const unit = getUnit(battle, 1);
        h.publish(updateUnit(battle, {
            ...unit,
            blockable: { ...unit.blockable, volume: blockableState.volume },
        }));
    };
    let state = setVolumeContribution(original.blockable, { id: "independent", value: 1 });
    state = setVolumeContribution(state, {
        id: "lower", value: 1, group: { id: "size", priority: 1 },
    });
    state = setVolumeContribution(state, {
        id: "higher", value: 2, group: { id: "size", priority: 2 },
    });
    replace(state);
    assert.equal(resolveVolume(original.definition.blockable, state), 4);
    assert.deepEqual(h.blocked(), [1]);
    const fallback = removeVolumeContribution(state, "higher");
    replace(fallback);
    assert.equal(resolveVolume(original.definition.blockable, fallback), 3);
    assert.deepEqual(h.blocked(), [1]);
    h.search();
    assert.deepEqual(h.blocked(), [1, 2]);
    assert.equal(resolveVolume(original.definition.blockable, state), 4);
    assert.equal(resolveVolume(original.definition.blockable, original.blockable), 1);
    assert.equal(resolveVolume(original.definition.blockable, removeVolumeContribution(fallback, "lower")), 2);
});

test("blocking volume: only integer additions are accepted", () => {
    const state = enemy(1).blockable;
    for (const value of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => setVolumeContribution(state, { id: "invalid", value }), RangeError);
    }
    assert.equal(resolveVolume({ volume: 2 }, setVolumeContribution(state, { id: "zero", value: 0 })), 2);
});

test("blocking volume: negative additions still consume one capacity while Rules control eligibility", () => {
    const h = battlefield([blocker(1), enemy(1, 2)]);
    assert.deepEqual(h.blocked(), []);
    for (const value of [-2, -10]) {
        const unit = h.state.units.get(1);
        h.commit(state => ({ ...state, units: new Map([...state.units, ...[{
            ...unit, blockable: setVolumeContribution(unit.blockable, { id: "reduced", value }),
        }].map(unit => [unit.id, unit])]) }));
        const current = h.state.units.get(1);
        assert.equal(resolveVolume(current.definition.blockable, current.blockable), 1);
        assert.equal(canBeBlocked(current), true);
        h.search();
        assert.deepEqual(h.blocked(), [1]);
        assert.equal(usedCapacity(h.work(), { id: 0 }), 1);
    }
    h.commit(state => ({ ...state, units: new Map([...state.units, ...[enemy(2)].map(unit => [unit.id, unit])]) }));
    assert.deepEqual(h.blocked(), [1]);
    const unit = h.state.units.get(1);
    h.commit(state => ({ ...state, units: new Map([...state.units, ...[{
        ...unit, blockable: setRule(unit.blockable, { id: "unblockable", allows: () => false }),
    }].map(unit => [unit.id, unit])]) }));
    assert.equal(canBeBlocked(h.state.units.get(1)), false);
    assert.deepEqual(h.blocked(), []);
    h.search();
    assert.deepEqual(h.blocked(), [2]);
});

test("blocking eligibility: overlapping rules release and reacquire targets independently of volume", () => {
    const h = battlefield([blocker(), enemy(1), enemy(2)]);
    const original = h.state.units.get(1);
    const first = { id: "first", allows: () => false };
    const second = { id: "second", allows: () => false };
    const change = (transition) => {
        const unit = h.state.units.get(1);
        h.commit(state => ({ ...state, units: new Map([...state.units, ...[{ ...unit, blockable: transition(unit.blockable) }].map(unit => [unit.id, unit])]) }));
    };
    change(state => setRule(state, first));
    assert.deepEqual(h.blocked(), [2]);
    change(state => setRule(state, second));
    change(state => removeRule(state, first.id));
    assert.equal(canBeBlocked(h.state.units.get(1)), false);
    assert.deepEqual(h.blocked(), [2]);
    change(state => removeRule(state, second.id));
    assert.equal(canBeBlocked(h.state.units.get(1)), true);
    assert.deepEqual(h.blocked(), [2]);
    h.search();
    assert.deepEqual(h.blocked(), [2, 1]);
    assert.equal(resolveVolume(original.definition.blockable, original.blockable), 1);
    assert.deepEqual(original.blockable.rules, []);
});

test("blocking volume: equivalent contribution changes leave the blocking projection clean", () => {
    const h = battlefield([blocker(), enemy(1)]);
    const before = h.state;
    const unit = before.units.get(1);
    const changed = {
        ...unit,
        blockable: setVolumeContribution(
            setVolumeContribution(unit.blockable, { id: "positive", value: 1 }),
            { id: "negative", value: -1 },
        ),
    };
    const result = h.commit(state => ({ ...state, units: new Map([...state.units, ...[changed].map(unit => [unit.id, unit])]) }));
    assert.equal(h.state.units.get(0).blocker.blocked, before.units.get(0).blocker.blocked);
    assert.equal(h.state.occupancy, before.occupancy);
    assert.deepEqual(view(h.state).unitsAt([0, 0]).map(unit => unit.id), view(before).unitsAt([0, 0]).map(unit => unit.id));
    assert.equal(h.state.navigation, before.navigation);
});

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
            stackCount: rule.validStackCount(instance.data.stackCount),
            readSourceAttribute: () => undefined,
        }),
    ]);
    let content;
    content = contributionEffect(
        raw.node._buff.buffKey,
        { stackCount: 3, lifetimeTicks: 2 },
        setting,
        {
            onTick(state, self) {
                if (state.tick < deadline(self)) return state;
                const plan = rule.expire(
                    { stackCount: self.data.stackCount, expiresAtTick: deadline(self) },
                    self.data.lifetimeTicks,
                    state.tick,
                );
                if (plan.type === "FINISH")
                    return effects.end(state, effectRef(self), "EXPIRED");
                else {
                    state = effects.update(state, effectRef(self), data => ({
                        ...data,
                        stackCount: plan.stackCount,
                    }));
                    state = replaceEffectFixture(
                        state,
                        effectRef(self),
                        setDeadline(effects.get(state, effectRef(self)), plan.expiresAtTick),
                    );
                    return refreshContribution(state, effectRef(self), content, setting);
                }
            },
        },
    );
    const h = battlefield([blocker(), enemy(1), enemy(2), enemy(3), enemy(4, 4)]);
    const original = h.state;
    let work = h.work();
    work = install(work, content, 2).state;
    h.publish(work);
    assert.deepEqual(h.blocked(), []);
    for (const [tick, remaining] of [
        [2, 1],
        [4, 2],
        [6, 3],
    ]) {
        let work = h.work();
        work = effects.advance(at(work, tick));
        h.publish(work);
        h.search();
        assert.equal(capacityOf(h.state.units.get(0)), remaining);
        assert.deepEqual(
            h.blocked(),
            Array.from({ length: remaining }, (_, index) => index + 1),
        );
    }
    assert.deepEqual(h.state.units.get(0).effects.values().toArray(), []);
    assert.equal(original.units.get(0).blocker.capacity.length, 0);
});

test("blocking capacity: native zero scaler releases weighted targets and restores capacity independently of their volume", () => {
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
    let work = h.work();
    work = install(work, content).state;
    h.publish(work);
    assert.deepEqual(h.blocked(), []);
    let paused = h.work();
    paused = effects.setEnabled(paused, effectAddress, false);
    h.publish(paused);
    assert.deepEqual(h.blocked(), []);
    h.search();
    assert.deepEqual(h.blocked(), [1, 2]);
    let resumed = h.work();
    resumed = effects.setEnabled(resumed, effectAddress, true);
    h.publish(resumed);
    assert.deepEqual(h.blocked(), []);
    let finished = h.work();
    finished = effects.end(finished, effectAddress);
    h.publish(finished);
    assert.deepEqual(h.blocked(), []);
    h.search();
    assert.deepEqual(h.blocked(), [1, 2]);
    assert.deepEqual(
        [...h.state.units.values()].slice(1).map((unit) => resolveVolume(unit.definition.blockable, unit.blockable)),
        [2, 1, 4],
    );
});

test("blocking capacity: replacing contribution entries without changing the resolved number leaves projection clean", () => {
    const h = battlefield([blocker(), enemy(1)]);
    const before = h.state;
    const owner = before.units.get(0);
    const changed = {
        ...owner,
        blocker: setCapacityContribution(
            setCapacityContribution(owner.blocker, entry("positive", modifier.create({ addition: 1 }))),
            entry("negative", modifier.create({ addition: -1 })),
        ),
    };
    assert.notEqual(changed.blocker.capacity, owner.blocker.capacity);
    assert.equal(capacityOf(changed), capacityOf(owner));
    const result = h.commit(state => ({ ...state, units: new Map([...state.units, ...[changed].map(unit => [unit.id, unit])]) }));
    assert.equal(h.state.units.get(0).blocker.blocked, before.units.get(0).blocker.blocked);
    assert.equal(h.state.occupancy, before.occupancy);
    assert.deepEqual(view(h.state).unitsAt([0, 0]).map(unit => unit.id), view(before).unitsAt([0, 0]).map(unit => unit.id));
    assert.equal(h.state.navigation, before.navigation);
    const refreshed = ({ ...h.state.units.get(0), blocker: setCapacityContribution(h.state.units.get(0).blocker, entry("positive", modifier.create({ addition: 1.1 }))) });
    assert.equal(capacityOf(refreshed), 3);
    h.commit(state => ({ ...state, units: new Map([...state.units, ...[refreshed].map(unit => [unit.id, unit])]) }));
    assert.equal(h.state.units.get(0).blocker.blocked, before.units.get(0).blocker.blocked);
});
