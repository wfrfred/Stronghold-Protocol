import { setDeadline, setData } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../helpers/unit.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
import { effectFixtureWork, install, definition, at } from "../helpers/effects.js";

const unit = () =>
    initialize({
        id: 0,
        position: [0, 0],
        definition: { id: "expiry-unit", vitality: { maxHp: 100 } },
    });

test("effect deadlines: one time advance ticks the active Effect then ends it at the deadline", () => {
    const trace = [];
    const value = definition(
        "deadline",
        {},
        {
            onTick: (state, context) => {
                trace.push(["tick", context.tick]);
                return state;
            },
            onDisable: (state) => {
                trace.push(["disable"]);
                return state;
            },
            onEnd: (state, context) => {
                trace.push(["end", context.self.status]);
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, value, 0, {
        scopes: [{ type: "TICK", tick: 2 }],
    }));
    battle = effect.advance(at(battle, 1));
    assert.ok(get(battle, ref));
    battle = effect.advance(at(battle, 2));
    assert.equal(get(battle, ref), undefined);
    battle = effect.advance(at(battle, 3));
    assert.deepEqual(trace, [["tick", 1], ["tick", 2], ["disable"], ["end", "ENDING"]]);
});

test("effect deadlines: layered content renews the same identity and ends only after its last layer", () => {
    const value = definition(
        "layered",
        { layers: 3, deadline: 2 },
        {
            onTick(state, context) {
                if (context.tick < context.self.data.deadline) return state;
                const layers = context.self.data.layers - 1;
                if (layers === 0) {
                    return effect.end(state, context.ref, "LAYERS_EXHAUSTED");
                }
                const deadline = context.tick + 2;
                return effect.replaceEffect(
                    state,
                    context.ref,
                    setDeadline(
                        setData(context.self, { layers, deadline }),
                        deadline,
                    ),
                );
            },
        },
    );
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, value, 0, {
        scopes: [{ type: "TICK", tick: 2 }],
    }));
    for (let tick = 0; tick < 6; tick++) battle = effect.advance(at(battle, tick));
    assert.equal(get(battle, ref).data.layers, 1);
    assert.equal(get(battle, ref).id, ref.id);
    battle = effect.advance(at(battle, 6));
    assert.equal(get(battle, ref), undefined);
});

test("effect deadlines: current scopes are read after an earlier callback renews a later candidate", () => {
    let later;
    const early = definition(
        "renewer",
        {},
        {
            onTick(state) {
                return effect.replaceEffect(
                    state,
                    later,
                    setDeadline(get(state, later), 10),
                );
            },
        },
    );
    let battle = effectFixtureWork(unit());
    battle = install(battle, early).state;
    ({ state: battle, value: later } = install(battle, definition("later"), 0, {
        scopes: [{ type: "TICK", tick: 2 }],
    }));
    battle = effect.advance(at(battle, 2));
    assert.ok(get(battle, later));
});

test("effect deadlines: removing a deadline keeps an otherwise active instance alive", () => {
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, definition("permanent"), 0, {
        scopes: [{ type: "TICK", tick: 1 }],
    }));
    battle = effect.replaceEffect(battle, ref, setDeadline(get(battle, ref), null));
    battle = effect.advance(at(battle, 100));
    assert.equal(get(battle, ref).status, "ACTIVE");
});
