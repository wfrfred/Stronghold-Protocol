import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
import { effectFixtureWork, install, definition, at } from "../helpers/effects.js";

const unit = (id) =>
    initialize({
        id,
        position: [0, 0],
        definition: { id: `periodic-${id}`, vitality: { maxHp: 100 } },
    });

test("effect time: content controls periodic intervals and state is visible before nested operations", () => {
    const seen = [];
    const value = definition(
        "periodic",
        { nextTick: 0, count: 0 },
        {
            onTick(state, context) {
                if (context.tick < context.self.data.nextTick) return state;
                const next = setData(context.self, (current) => ({
                    nextTick: context.tick + 3,
                    count: current.count + 1,
                }));
                state = effect.replaceEffect(state, context.ref, next);
                seen.push([context.tick, get(state, context.ref).data.count]);
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0));
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    for (let tick = 0; tick <= 7; tick++) battle = effect.advance(at(battle, tick));
    assert.deepEqual(seen, [
        [0, 1],
        [3, 2],
        [6, 3],
    ]);
    assert.equal(get(battle, ref).data.count, 3);
});

test("effect time: inactive Effects do not tick, but their deadlines continue to expire", () => {
    const value = definition("disabled", {}, { onTick: () => assert.fail("inactive tick") });
    let battle = effectFixtureWork(unit(0));
    let ref;
    ({ state: battle, value: ref } = install(battle, value, 0, {
        enabled: false,
        scopes: [{ type: "TICK", tick: 2 }],
    }));
    battle = effect.advance(at(battle, 1));
    assert.equal(get(battle, ref).status, "INACTIVE");
    battle = effect.advance(at(battle, 2));
    assert.equal(get(battle, ref), undefined);
});

test("effect time: periodic progress pauses while inactive and resumes from the saved progress", () => {
    const triggered = [];
    const value = definition(
        "paused-periodic",
        { progress: 0 },
        {
            onTick(state, context) {
                const progress = context.self.data.progress + 1;
                state = effect.replaceEffect(
                    state,
                    context.ref,
                    setData(context.self, { progress: progress === 5 ? 0 : progress }),
                );

                if (progress === 5) triggered.push(context.tick);
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0));
    let ref;
    ({ state: battle, value: ref } = install(battle, value));

    battle = effect.advance(at(battle, 0));
    battle = effect.advance(at(battle, 1));
    battle = effect.setEnabled(battle, ref, false);
    for (let tick = 2; tick < 12; tick++) battle = effect.advance(at(battle, tick));
    assert.equal(get(battle, ref).data.progress, 2);

    battle = effect.setEnabled(battle, ref, true);
    battle = effect.advance(at(battle, 12));
    battle = effect.advance(at(battle, 13));
    assert.deepEqual(triggered, []);
    battle = effect.advance(at(battle, 14));
    assert.deepEqual(triggered, [14]);
    assert.equal(get(battle, ref).data.progress, 0);
});

test("effect time: a new Effect waits for the next advance while ended candidates are skipped", () => {
    const seen = [];
    let later;
    const newborn = definition(
        "newborn",
        {},
        {
            onTick: (state) => {
                seen.push("newborn");
                return state;
            },
        },
    );
    const first = definition(
        "first",
        { spawned: false },
        {
            onTick(state, context) {
                seen.push("first");
                if (context.self.data.spawned) return state;
                state = effect.replaceEffect(
                    state,
                    context.ref,
                    setData(context.self, { spawned: true }),
                );
                state = effect.install(
                    state,
                    getUnit(state, context.unit.id),
                    newborn,
                    {},
                    context.call,
                ).state;
                return effect.end(state, later, "EXPLICIT", context.call);
            },
        },
    );
    const last = definition(
        "later",
        {},
        {
            onTick: (state) => {
                seen.push("later");
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0));
    battle = install(battle, first).state;
    ({ state: battle, value: later } = install(battle, last));
    battle = effect.advance(at(battle, 0));
    assert.deepEqual(seen, ["first"]);
    battle = effect.advance(at(battle, 1));
    assert.deepEqual(seen, ["first", "first", "newborn"]);
});

test("effect time: zero shield charges do not suspend the periodic recharge Effect", () => {
    const value = definition(
        "shield-recharge",
        { charges: 0 },
        {
            onTick(state, context) {
                return effect.replaceEffect(
                    state,
                    context.ref,
                    setData(context.self, (current) => ({
                        charges: Math.min(3, current.charges + 1),
                    })),
                );
            },
        },
    );
    let battle = effectFixtureWork(unit(0));
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    battle = effect.advance(at(battle, 0));
    assert.equal(get(battle, ref).data.charges, 1);
    assert.equal(get(battle, ref).status, "ACTIVE");
});
