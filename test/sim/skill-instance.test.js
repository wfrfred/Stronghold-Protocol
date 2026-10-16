import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { get, replaceActivation } from "../../dist/core/tactical/unit/capability/skill/query.js";
import { get as getInstance, replace, setData } from "../../dist/core/tactical/unit/capability/skill/instance.js";
import * as operations from "../../dist/core/tactical/unit/capability/skill/operations.js";
import { ref } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import { fixture, definition, at } from "../helpers/skill.js";

test("Skill programs receive paired private state without specializing their host capability", () => {
    const observed = [];
    const f = fixture({
        sp: null,
        initialize: () => ({ count: 0 }),
        onEnter(battle, self) {
            assert.equal(self.definition, f.definition);
            assert.equal(self.host.id, f.unit.id);
            return replace(battle, setData(self, ({ count }) => ({ count: count + 1 })));
        },
        onTick(battle, self) {
            return replace(battle, setData(self, ({ count }) => ({ count: count + 1 })));
        },
        activation: {
            trigger: "MANUAL", sustain: { type: "INFINITE" },
            initialize: (_battle, self) => ({ sampled: self.state.data.count }),
            onStart(battle, self) {
                observed.push([self.id, self.data.sampled]);
                assert.equal(get(battle, ref(self)), self);
                return battle;
            },
        },
    });
    let battle = operations.enter(f.state, f.ref);
    const first = operations.activate(battle, f.ref);
    battle = operations.finish(first.state, first.value.ref);
    battle = operations.advance(at(battle, 1), f.ref);
    const second = operations.activate(battle, f.ref);
    assert.deepEqual(observed, [[0, 1], [1, 2]]);
    assert.deepEqual(getUnit(second.state, f.unit.id).skill.data, { count: 2 });
    assert.deepEqual(f.unit.skill.data, { count: 0 });
});

test("a Skill Definition token restores activation data only for its configured program", () => {
    const f = fixture({
        initialize: () => ({ count: 1 }), sp: null,
        activation: {
            trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}),
            onStart(battle, self) {
                const program = getInstance(battle, self.host, f.definition);
                return replace(battle, setData(program, ({ count }) => ({ count: count + 1 })));
            },
        },
    });
    const started = operations.activate(f.state, f.ref);
    const other = definition({ id: f.definition.id });
    assert.notEqual(other, f.definition);
    assert.equal(getInstance(started.state, f.ref, other), undefined);
    assert.deepEqual(getInstance(started.state, f.ref, f.definition).state.data, { count: 2 });
    assert.equal(get(started.state, started.value.ref, other), undefined);
    assert.equal(get(started.state, started.value.ref, f.definition), getUnit(started.state, f.unit.id).skill.active);
    const finished = operations.finish(started.state, started.value.ref);
    assert.equal(get(finished, started.value.ref, f.definition), undefined);
});

test("activation writeback uses its reference identity and cannot replace a later activation", () => {
    const f = fixture({ sp: null });
    const first = operations.activate(f.state, f.ref);
    const active = get(first.state, first.value.ref);
    const updated = replaceActivation(first.state, first.value.ref, { ...active, data: { count: 2 } });
    assert.deepEqual(get(updated, first.value.ref).data, { count: 2 });
    const finished = operations.finish(updated, first.value.ref);
    const second = operations.activate(finished, f.ref);
    assert.notEqual(first.value.ref.id, second.value.ref.id);
    assert.equal(replaceActivation(second.state, first.value.ref, active), second.state);
    assert.deepEqual(get(second.state, second.value.ref).data, {});
});
