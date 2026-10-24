import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import * as skills from "../../dist/core/tactical/unit/capability/skill/operations.js";
import { ref as activationRef } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import * as query from "../../dist/core/tactical/unit/capability/skill/query.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { initialize } from "../helpers/unit.js";
import { definition as effectDefinition, effectFixtureWork } from "../helpers/effects.js";
import { definition, at } from "../helpers/skill.js";

function fixture(callbacks = {}) {
    const ended = [];
    const disabled = [];
    const owned = effectDefinition("skill-owned", {}, {
        onDisable(battle, context) {
            disabled.push(context.ref.id);
            return callbacks.disable?.(battle, context) ?? battle;
        },
    });
    const installOwned = (battle, self, expected = true) => {
        for (const extra of [[], [{ type: "UNIT", ref: unitRef(getUnit(battle, 1)) }]]) {
            const installed = effects.install(battle, unitRef(getUnit(battle, 1)), owned, {
                source: self.host.id,
                scopes: [{ type: "SKILL", ref: activationRef(self) }, ...extra],
            });
            battle = installed.state;
            assert.equal(installed.value !== undefined, expected);
        }
        return battle;
    };
    const skill = definition({ sp: null, activation: {
        trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}),
        onStart: (battle, self) => callbacks.start?.(battle, self, installOwned) ?? installOwned(battle, self),
        onEnd(battle, self, end) {
            const host = getUnit(battle, self.host.id);
            ended.push({ status: host?.skill.active?.status, lifecycle: host?.lifecycle, end });
            return callbacks.end?.(battle, self, end) ?? battle;
        },
    } });
    const source = initialize({ id: 0, position: [0, 0], definition: { id: "source", skill, vitality: { maxHp: 100, defense: 0, resistance: 0 } } });
    const receiver = initialize({ id: 1, position: [1, 0], definition: { id: "receiver", vitality: { maxHp: 100, defense: 0, resistance: 0 } } });
    return { state: effectFixtureWork(source, receiver), source: unitRef(source), ended, disabled };
}

for (const reason of ["DEATH", "RETREAT", "SCRIPT"]) {
    test(`${reason} closes skill dependents once before removing the host`, () => {
        const f = fixture();
        const started = skills.activate(f.state, f.source);
        const state = leave(at(started.state, 1), 0, reason);
        assert.equal(getUnit(state, 0), undefined);
        assert.deepEqual(getUnit(state, 1).effects.values().toArray(), []);
        assert.deepEqual(f.disabled, [0, 1]);
        assert.deepEqual(f.ended, [{ status: "ENDING", lifecycle: "LEAVING", end: { type: "CANCELLED", reason } }]);
        assert.equal(state.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
        assert.equal(getUnit(started.state, 0).skill.active.status, "ACTIVE");
        assert.equal(getUnit(started.state, 1).effects.values().toArray().length, 2);
        assert.equal(leave(state, 0, reason), state);
        assert.equal(f.ended.length, 1);
    });
}

test("entered start content continues after host departure and late lifetime dependencies are rejected", () => {
    const trace = [];
    const f = fixture({ start(battle, self, installOwned) {
        battle = installOwned(battle, self);
        battle = leave(battle, self.host.id, "SCRIPT");
        trace.push("continued");
        assert.equal(query.get(battle, activationRef(self)), undefined);
        battle = installOwned(battle, self, false);
        assert.equal(getUnit(battle, 1).effects.nextId, 2);
        return battle;
    } });
    const activated = skills.activate(f.state, f.source);
    assert.deepEqual(trace, ["continued"]);
    assert.equal(getUnit(activated.state, 0), undefined);
    assert.deepEqual(getUnit(activated.state, 1).effects.values().toArray(), []);
    assert.equal(f.ended.length, 1);
    assert.deepEqual(f.disabled, [0, 1]);
    assert.equal(getUnit(f.state, 0).skill.active, null);
    assert.equal(getUnit(f.state, 1).effects.nextId, 0);
});

test("termination closes dependent lifetimes before onEnd and reentrant termination has no second effect", () => {
    let callbacks = 0;
    const f = fixture({ end(battle, self) {
        callbacks++;
        assert.deepEqual(getUnit(battle, 1).effects.values().toArray(), []);
        assert.equal(query.get(battle, activationRef(self)).status, "ENDING");
        assert.equal(skills.finish(battle, activationRef(self)), battle);
        assert.equal(skills.cancel(battle, activationRef(self), "NESTED"), battle);
        return battle;
    } });
    const started = skills.activate(f.state, f.source);
    const finished = skills.finish(started.state, started.value.ref);
    assert.equal(callbacks, 1);
    assert.equal(query.get(finished, started.value.ref), undefined);
    assert.equal(skills.finish(finished, started.value.ref), finished);
    assert.equal(callbacks, 1);
});

test("ending content may create independent remote effects while closed lifetime bindings remain unavailable", () => {
    const independent = effectDefinition("independent");
    let installedRef;
    const f = fixture({ end(battle, self) {
        const host = unitRef(getUnit(battle, 1));
        const bound = effects.install(battle, host, independent, { scopes: [{ type: "SKILL", ref: activationRef(self) }] });
        assert.equal(bound.value, undefined);
        const installed = effects.install(bound.state, host, independent);
        installedRef = installed.value;
        return installed.state;
    } });
    const started = skills.activate(f.state, f.source);
    const finished = skills.finish(started.state, started.value.ref);
    assert.equal(getUnit(finished, 1).effects.values().toArray().length, 1);
    assert.equal(effects.get(finished, installedRef).status, "ACTIVE");
});

test("departure cleanup failures propagate without changing the input version", () => {
    const failure = new Error("cleanup failed");
    const f = fixture({ disable() { throw failure; } });
    const started = skills.activate(f.state, f.source);
    assert.throws(() => leave(started.state, 0, "SCRIPT"), (error) => error === failure);
    assert.equal(getUnit(started.state, 0).lifecycle, "PRESENT");
    assert.equal(getUnit(started.state, 0).skill.active.status, "ACTIVE");
    assert.equal(getUnit(started.state, 1).effects.values().toArray().length, 2);
});
