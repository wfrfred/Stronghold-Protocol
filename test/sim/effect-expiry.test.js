import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";
import { effectFixtureWork, install, definition, at } from "../helpers/effects.js";

const unit = () =>
    initializeUnit({
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
            onTick: (context) => trace.push(["tick", context.tick]),
            onDisable: () => trace.push(["disable"]),
            onEnd: (context) => trace.push(["end", context.self.status]),
        },
    );
    const battle = effectFixtureWork(unit());
    const ref = install(battle, value, 0, { scopes: [{ type: "TICK", tick: 2 }] });
    effect.advance(at(battle, 1));
    assert.ok(get(battle, ref));
    effect.advance(at(battle, 2));
    assert.equal(get(battle, ref), undefined);
    effect.advance(at(battle, 3));
    assert.deepEqual(trace, [["tick", 1], ["tick", 2], ["disable"], ["end", "ENDING"]]);
});

test("effect deadlines: layered content renews the same identity and ends only after its last layer", () => {
    const value = definition(
        "layered",
        { layers: 3, deadline: 2 },
        {
            onTick(context) {
                if (context.tick < context.self.state.deadline) return;
                const layers = context.self.state.layers - 1;
                if (layers === 0) {
                    context.end("LAYERS_EXHAUSTED");
                    return;
                }
                const deadline = context.tick + 2;
                context.setState({ layers, deadline });
                effect.setDeadline(context.battle, context.ref, deadline);
            },
        },
    );
    const battle = effectFixtureWork(unit());
    const ref = install(battle, value, 0, { scopes: [{ type: "TICK", tick: 2 }] });
    for (let tick = 0; tick < 6; tick++) effect.advance(at(battle, tick));
    assert.equal(get(battle, ref).state.layers, 1);
    assert.equal(get(battle, ref).id, ref.effectId);
    effect.advance(at(battle, 6));
    assert.equal(get(battle, ref), undefined);
});

test("effect deadlines: current scopes are read after an earlier callback renews a later candidate", () => {
    let later;
    const early = definition(
        "renewer",
        {},
        {
            onTick(context) {
                effect.setDeadline(context.battle, later, 10);
            },
        },
    );
    const battle = effectFixtureWork(unit());
    install(battle, early);
    later = install(battle, definition("later"), 0, { scopes: [{ type: "TICK", tick: 2 }] });
    effect.advance(at(battle, 2));
    assert.ok(get(battle, later));
});

test("effect deadlines: removing a deadline keeps an otherwise active instance alive", () => {
    const battle = effectFixtureWork(unit());
    const ref = install(battle, definition("permanent"), 0, {
        scopes: [{ type: "TICK", tick: 1 }],
    });
    effect.setDeadline(battle, ref, null);
    effect.advance(at(battle, 100));
    assert.equal(get(battle, ref).status, "ACTIVE");
});
