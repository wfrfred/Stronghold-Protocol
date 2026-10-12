import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";
import { effectFixtureWork, install, definition, at } from "../helpers/effects.js";

const unit = (id) =>
    initializeUnit({
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
            onTick(context) {
                if (context.tick < context.self.state.nextTick) return;
                context.setState((current) => ({
                    nextTick: context.tick + 3,
                    count: current.count + 1,
                }));
                seen.push([context.tick, get(context.battle, context.ref).state.count]);
            },
        },
    );
    const battle = effectFixtureWork(unit(0));
    const ref = install(battle, value);
    for (let tick = 0; tick <= 7; tick++) effect.advance(at(battle, tick));
    assert.deepEqual(seen, [
        [0, 1],
        [3, 2],
        [6, 3],
    ]);
    assert.equal(get(battle, ref).state.count, 3);
});

test("effect time: inactive Effects do not tick, but their deadlines continue to expire", () => {
    const value = definition("disabled", {}, { onTick: () => assert.fail("inactive tick") });
    const battle = effectFixtureWork(unit(0));
    const ref = install(battle, value, 0, { enabled: false, scopes: [{ type: "TICK", tick: 2 }] });
    effect.advance(at(battle, 1));
    assert.equal(get(battle, ref).status, "INACTIVE");
    effect.advance(at(battle, 2));
    assert.equal(get(battle, ref), undefined);
});

test("effect time: periodic progress pauses while inactive and resumes from the saved progress", () => {
    const triggered = [];
    const value = definition(
        "paused-periodic",
        { progress: 0 },
        {
            onTick(context) {
                const progress = context.self.state.progress + 1;
                context.setState({ progress: progress === 5 ? 0 : progress });

                if (progress === 5) triggered.push(context.tick);
            },
        },
    );
    const battle = effectFixtureWork(unit(0));
    const ref = install(battle, value);

    effect.advance(at(battle, 0));
    effect.advance(at(battle, 1));
    effect.setEnabled(battle, ref, false);
    for (let tick = 2; tick < 12; tick++) effect.advance(at(battle, tick));
    assert.equal(get(battle, ref).state.progress, 2);

    effect.setEnabled(battle, ref, true);
    effect.advance(at(battle, 12));
    effect.advance(at(battle, 13));
    assert.deepEqual(triggered, []);
    effect.advance(at(battle, 14));
    assert.deepEqual(triggered, [14]);
    assert.equal(get(battle, ref).state.progress, 0);
});

test("effect time: a new Effect waits for the next advance while ended candidates are skipped", () => {
    const seen = [];
    let later;
    const newborn = definition("newborn", {}, { onTick: () => seen.push("newborn") });
    const first = definition(
        "first",
        { spawned: false },
        {
            onTick(context) {
                seen.push("first");
                if (context.self.state.spawned) return;
                context.setState({ spawned: true });
                effect.install(context.battle, context.unit, newborn);
                effect.end(context.battle, later);
            },
        },
    );
    const last = definition("later", {}, { onTick: () => seen.push("later") });
    const battle = effectFixtureWork(unit(0));
    install(battle, first);
    later = install(battle, last);
    effect.advance(at(battle, 0));
    assert.deepEqual(seen, ["first"]);
    effect.advance(at(battle, 1));
    assert.deepEqual(seen, ["first", "first", "newborn"]);
});

test("effect time: zero shield charges do not suspend the periodic recharge Effect", () => {
    const value = definition(
        "shield-recharge",
        { charges: 0 },
        {
            onTick(context) {
                context.setState((current) => ({ charges: Math.min(3, current.charges + 1) }));
            },
        },
    );
    const battle = effectFixtureWork(unit(0));
    const ref = install(battle, value);
    effect.advance(at(battle, 0));
    assert.equal(get(battle, ref).state.charges, 1);
    assert.equal(get(battle, ref).status, "ACTIVE");
});
