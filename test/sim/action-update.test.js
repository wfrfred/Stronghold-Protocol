import assert from "node:assert/strict";
import { test } from "node:test";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { ref } from "../../dist/core/tactical/unit/action/action.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import * as units from "../../dist/core/tactical/unit/query.js";
import { registerUnit, removeUnit } from "../../dist/core/tactical/battle/state.js";
import { fixtureBattle } from "../helpers/unit.js";

const program = (id = "primary", state = { count: 0 }, extra = {}) => ({
    id,
    intervalTicks: 10,
    speed: 100,
    initialize: battle => ({ state: battle, value: {} }),
    start: battle => ({ state: battle, value: { ...state } }),
    step: battle => ({ state: battle, value: false }),
    ...extra,
});

function create(programs = [program()]) {
    const initialized = initialize(fixtureBattle(), {
        id: 0,
        position: [0, 0],
        definition: {
            id: "update-owner",
            action: { definitions: programs.reduce((definitions, item) => definitions.add(item), Definitions.empty()) },
        },
    });
    const source = units.ref(initialized.value);
    let battle = registerUnit(initialized.state, initialized.value);
    const references = [];

    for (const definition of programs) {
        const started = actions.start(battle, source, definition);
        assert.equal(started.value.type, "STARTED");
        battle = started.state;
        references.push(started.value.ref);
    }

    return { battle, source, references };
}

test("Action update transforms the latest private state rather than an earlier instance snapshot", () => {
    const fixture = create();
    const reference = fixture.references[0];
    const original = actions.get(fixture.battle, reference);
    const first = actions.update(fixture.battle, reference, current => ({ ...current, count: current.count + 1 }));
    const firstInstance = actions.get(first, reference);
    let received;
    const second = actions.update(first, reference, current => {
        received = current;
        return { ...current, count: current.count + 1 };
    });

    assert.strictEqual(received, firstInstance.state);
    assert.equal(actions.get(second, reference).state.count, 2);
    assert.equal(actions.get(first, reference).state.count, 1);
    assert.equal(actions.get(fixture.battle, reference).state.count, 0);
    assert.strictEqual(actions.get(fixture.battle, reference), original);
});

test("Action update preserves identity, program, lifecycle and unrelated host state", () => {
    const fixture = create([program(), program("sibling", { message: "ready" })]);
    const [reference, siblingRef] = fixture.references;
    const original = actions.get(fixture.battle, reference);
    const sibling = actions.get(fixture.battle, siblingRef);
    const originalHost = units.get(fixture.battle, fixture.source);
    const changed = actions.update(fixture.battle, reference, current => ({ ...current, count: 7 }));
    const next = actions.get(changed, reference);
    const nextHost = units.get(changed, fixture.source);

    assert.equal(next.state.count, 7);
    assert.equal(next.id, original.id);
    assert.strictEqual(next.host, original.host);
    assert.strictEqual(next.definition, original.definition);
    assert.equal(next.startedAtTick, original.startedAtTick);
    assert.equal(next.status, original.status);
    assert.strictEqual(actions.get(changed, siblingRef), sibling);
    assert.equal(nextHost.action.instances.nextId, originalHost.action.instances.nextId);
    assert.strictEqual(nextHost.action.states, originalHost.action.states);
    assert.strictEqual(nextHost.effects, originalHost.effects);
    assert.strictEqual(nextHost.position, originalHost.position);
    assert.deepEqual(changed.events, fixture.battle.events);
});

test("Action update returning the current private state keeps the complete BattleState unchanged", () => {
    const fixture = create();
    const reference = fixture.references[0];
    const original = actions.get(fixture.battle, reference);
    let calls = 0;
    const result = actions.update(fixture.battle, reference, current => {
        calls++;
        assert.strictEqual(current, original.state);
        return current;
    });

    assert.equal(calls, 1);
    assert.strictEqual(result, fixture.battle);
    assert.strictEqual(actions.get(result, reference), original);
});

test("Action update does not invoke transforms for removed instances or missing hosts", () => {
    const fixture = create();
    const reference = fixture.references[0];
    const removed = actions.cancel(fixture.battle, reference, "TEST");
    const absentHost = removeUnit(fixture.battle, fixture.source.id, "SCRIPT");
    const forbidden = () => assert.fail("an absent Action must not execute its state transform");

    assert.strictEqual(actions.update(removed, reference, forbidden), removed);
    assert.strictEqual(actions.update(absentHost, reference, forbidden), absentHost);
    assert.equal(actions.get(removed, reference), undefined);
    assert.equal(actions.get(absentHost, reference), undefined);
    assert.equal(actions.get(fixture.battle, reference).state.count, 0);
});

test("Action update skips ENDING instances during synchronous termination callbacks", () => {
    let attempts = 0;
    let observed;
    const configured = program("ending", { count: 3 }, {
        onEnd(battle, self) {
            observed = actions.get(battle, ref(self));
            const result = actions.update(battle, ref(self), () => {
                attempts++;
                return { count: 100 };
            });
            assert.strictEqual(result, battle);
            return result;
        },
    });
    const fixture = create([configured]);
    const reference = fixture.references[0];
    const cancelled = actions.cancel(fixture.battle, reference, "TEST");

    assert.equal(attempts, 0);
    assert.equal(observed.status, "ENDING");
    assert.equal(observed.state.count, 3);
    assert.equal(actions.get(cancelled, reference), undefined);
    assert.equal(actions.get(fixture.battle, reference).state.count, 3);
});

test("Action update distinguishes identical local execution IDs on different hosts", () => {
    const configured = program();
    const fixture = create([configured]);
    const second = initialize(fixture.battle, {
        id: 1,
        position: [1, 0],
        definition: { id: "second-owner", action: { definitions: Definitions.empty().add(configured) } },
    });
    const withSecond = registerUnit(second.state, second.value);
    const started = actions.start(withSecond, units.ref(second.value), configured);
    assert.equal(started.value.type, "STARTED");
    const firstRef = fixture.references[0];
    const secondRef = started.value.ref;
    assert.equal(firstRef.id, secondRef.id);
    assert.notEqual(firstRef.host.id, secondRef.host.id);
    const first = actions.get(started.state, firstRef);
    const changed = actions.update(started.state, secondRef, current => ({ ...current, count: 8 }));

    assert.strictEqual(actions.get(changed, firstRef), first);
    assert.equal(actions.get(changed, secondRef).state.count, 8);
    assert.equal(actions.get(started.state, secondRef).state.count, 0);
});

test("A throwing Action transform cannot modify any already published instance", () => {
    const fixture = create();
    const reference = fixture.references[0];
    const changed = actions.update(fixture.battle, reference, current => ({ ...current, count: 1 }));
    const prior = actions.get(changed, reference);

    assert.throws(() => actions.update(changed, reference, () => {
        throw new Error("transform failed");
    }), /transform failed/);
    assert.strictEqual(actions.get(changed, reference), prior);
    assert.equal(actions.get(changed, reference).state.count, 1);
    assert.equal(actions.get(fixture.battle, reference).state.count, 0);
});
