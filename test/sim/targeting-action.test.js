import assert from "node:assert/strict";
import { test } from "node:test";
import { createWithState, chooseTargets } from "../../dist/content/tactical/actions/attack.js";
import { select } from "../../dist/core/tactical/battle/targeting/select.js";
import { random } from "../../dist/core/tactical/battle/targeting/selector.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { ref } from "../../dist/core/tactical/unit/query.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { and, damage, healing, range } from "../../dist/core/tactical/battle/targeting/filter.js";
import { unit, battle } from "../helpers/action-fixture.js";

function definition(groups, start = state => ({ state, value: {} })) {
    return createWithState({
        id: "random-attack",
        intervalTicks: 10,
        windupTicks: 3,
        triggerBindingId: "primary",
        targetGroups: groups,
        initialize: state => ({ state, value: {} }),
        start,
    });
}

const group = (id, selector = random(1), filter = (_battle, request, target) => target.id !== request.source.id) => ({
    id,
    targeting: { purposes: ["DAMAGE"], filter, selector },
    operations: [{ type: "DAMAGE", power: 7, damageType: "TRUE" }],
});

test("attack target groups and start callbacks receive the RNG state produced by earlier selections", () => {
    let observed;
    const primary = group("primary");
    const secondary = group("secondary", random(2));
    const action = definition([primary, secondary], state => {
        observed = state.execution.rngState;
        return { state, value: { selectedAt: observed } };
    });
    const source = unit(0, { action });
    const initial = battle(source, unit(1), unit(2), unit(3));
    const seeded = { ...initial, execution: { ...initial.execution, rngState: 73 } };
    const first = select(seeded, { ...primary.targeting, source: ref(source) });
    const second = select(first.state, { ...secondary.targeting, source: ref(source) });
    const started = actions.start(seeded, ref(source), action);

    assert.equal(started.value.type, "STARTED");
    const running = actions.get(started.state, started.value.ref);
    assert.deepEqual(running.state.bindings, { primary: first.value, secondary: second.value });
    assert.equal(started.state.execution.rngState, second.state.execution.rngState);
    assert.equal(observed, second.state.execution.rngState);
    assert.equal(running.state.data.selectedAt, observed);
    assert.equal(seeded.execution.rngState, 73);
});

test("an attack rejected for an empty trigger binding retains completed target-selection state", () => {
    const primary = group("primary", random(1), () => false);
    const secondary = group("secondary");
    const action = definition([primary, secondary], () => assert.fail("a rejected attack must not start"));
    const source = unit(0, { action });
    const initial = battle(source, unit(1), unit(2));
    const selected = chooseTargets(initial, ref(source), action.attack);
    const started = actions.start(initial, ref(source), action);

    assert.deepEqual(selected.value.primary, []);
    assert.equal(selected.value.secondary.length, 1);
    assert.notEqual(selected.state.execution.rngState, initial.execution.rngState);
    assert.deepEqual(started.value, { type: "REJECTED", reason: "CONDITION" });
    assert.equal(started.state.execution.rngState, selected.state.execution.rngState);
    assert.equal(getUnit(started.state, 0).action.instances.size, 0);
});

test("standard damage and healing filters exclude departing and spatially absent candidates explicitly", () => {
    const source = unit(0);
    const base = unit(1);
    const ally = unit(2, { side: "ALLY" });
    const initial = battle(source, base, ally);
    const request = { source: ref(source), purposes: [], filter: () => true, selector: random(1) };

    for (const [filter, target] of [[damage, base], [healing, { ...ally, vitality: { ...ally.vitality, hp: 50 } }]]) {
        assert.equal(filter(initial, request, target), true);
        assert.equal(filter(initial, request, { ...target, lifecycle: "LEAVING" }), false);
        assert.equal(filter(initial, request, { ...target, spatialPresence: { present: false } }), false);
    }
});

test("targeting only requires a hitbox when a geometric range filter is composed", () => {
    const source = unit(0);
    const target = unit(1, { hitbox: undefined });
    const initial = battle(source, target);
    const request = { source: ref(source), purposes: ["DAMAGE"], filter: damage, selector: random(1) };

    assert.deepEqual(select(initial, request).value, [ref(target)]);
    assert.deepEqual(select(initial, {
        ...request,
        filter: and(damage, range([{ type: "CIRCLE", offset: [0, 0], radius: 10 }])),
    }).value, []);
});
