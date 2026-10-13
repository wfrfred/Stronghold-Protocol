import { battlefieldView } from "../../dist/core/tactical/battle/state.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { effectFixtureWork, install, definition } from "../helpers/effects.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";

const unit = () =>
    initialize({
        id: 0,
        position: [0, 0],
        definition: { id: "cleanup", vitality: { maxHp: 100 } },
    });

test("effect cleanup: terminal business sees the ending instance and ending immediately removes it", () => {
    const seen = [];
    const value = definition(
        "terminal",
        { count: 3 },
        {
            onEnd(state, context) {
                assert.equal(get(state, context.ref).status, "ENDING");
                seen.push(context.self.data.count);
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    const before = battlefieldView(battle);
    battle = effect.end(battle, ref);
    assert.equal(get(battle, ref), undefined);
    assert.deepEqual(seen, [3]);
    assert.equal(before.getUnit(0).effects.values()[0].status, "ACTIVE");
});

test("effect cleanup: a replacement installed during end uses a new identity and survives the old cleanup", () => {
    let next;
    const replacement = definition("replacement");
    const value = definition(
        "old",
        {},
        {
            onEnd(state, context) {
                const installed = effect.install(
                    state,
                    context.unit,
                    replacement,
                    {},
                    context.call,
                );
                next = installed.value;
                return installed.state;
            },
        },
    );
    let battle = effectFixtureWork(unit());
    let old;
    ({ state: battle, value: old } = install(battle, value));
    battle = effect.end(battle, old);
    assert.equal(get(battle, old), undefined);
    assert.notEqual(next.effectId, old.effectId);
    assert.equal(get(battle, next).definition, replacement);
});
