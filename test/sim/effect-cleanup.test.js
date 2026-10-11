import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { effectFixtureWork, install, definition } from "../helpers/effects.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";

const unit = () =>
    initializeUnit({
        id: 0,
        position: [0, 0],
        definition: { id: "cleanup", vitality: { maxHp: 100 } },
    });

test("effect cleanup: terminal business sees the finished instance and ending immediately removes it", () => {
    const seen = [];
    const value = definition(
        "terminal",
        { count: 3 },
        {
            onEnd(context) {
                assert.equal(get(context.battle, context.ref).status, "FINISHED");
                seen.push(context.self.state.count);
            },
        },
    );
    const battle = effectFixtureWork(unit());
    const ref = install(battle, value);
    const before = battle.battlefield.snapshot("draft");
    effect.end(battle, ref);
    assert.equal(get(battle, ref), undefined);
    assert.deepEqual(seen, [3]);
    assert.equal(before.getUnit(0).effects.instances[0].status, "ACTIVE");
});

test("effect cleanup: a replacement installed during end uses a new identity and survives the old cleanup", () => {
    let next;
    const replacement = definition("replacement");
    const value = definition(
        "old",
        {},
        {
            onEnd(context) {
                next = effect.apply(context.battle, context.unit, replacement);
            },
        },
    );
    const battle = effectFixtureWork(unit());
    const old = install(battle, value);
    effect.end(battle, old);
    assert.equal(get(battle, old), undefined);
    assert.notEqual(next.effectId, old.effectId);
    assert.equal(get(battle, next).definition, replacement);
});
