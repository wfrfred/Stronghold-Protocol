import assert from "node:assert/strict";
import { test } from "node:test";
import { battle } from "../helpers/action-fixture.js";
import * as projectiles from "../../dist/core/tactical/battlefield/projectile/operations.js";

const create = () => projectiles.create(battle(), { id: "updatable" }, {
    position: [0, 0], state: { count: 0 },
});

test("Projectile update reads the latest complete instance and preserves earlier snapshots", () => {
    const initial = create();
    const before = projectiles.get(initial.state, initial.value);
    const first = projectiles.update(initial.state, initial.value, current => ({
        position: [current.position[0] + 1, 0],
        state: { count: current.state.count + 1 },
    }));
    const firstInstance = projectiles.get(first, initial.value);
    let observed;
    const second = projectiles.update(first, initial.value, current => {
        observed = current;
        return {
            position: [current.position[0] + 1, 0],
            state: { count: current.state.count + 1 },
        };
    });

    assert.strictEqual(observed, firstInstance);
    assert.deepEqual(projectiles.get(second, initial.value).position, [2, 0]);
    assert.deepEqual(projectiles.get(second, initial.value).state, { count: 2 });
    assert.strictEqual(projectiles.get(initial.state, initial.value), before);
    assert.deepEqual(before.position, [0, 0]);
    assert.deepEqual(before.state, { count: 0 });
    assert.deepEqual(firstInstance.state, { count: 1 });
});

test("Projectile update writes only position and private state while preserving all unrelated facts", () => {
    const first = create();
    const second = projectiles.create(first.state, { id: "sibling" }, {
        position: [3, 0], state: { label: "untouched" },
    });
    const original = projectiles.get(second.state, first.value);
    const sibling = projectiles.get(second.state, second.value);
    const changed = projectiles.update(second.state, first.value, current => ({
        id: 999,
        lifecycle: "ENDING",
        definition: { id: "forbidden" },
        position: [1, 0],
        state: { count: current.state.count + 1 },
    }));
    const current = projectiles.get(changed, first.value);

    assert.equal(current.id, original.id);
    assert.strictEqual(current.definition, original.definition);
    assert.equal(current.lifecycle, "ACTIVE");
    assert.deepEqual(current.position, [1, 0]);
    assert.deepEqual(current.state, { count: 1 });
    assert.strictEqual(projectiles.get(changed, second.value), sibling);
    assert.strictEqual(changed.execution, second.state.execution);
    assert.strictEqual(changed.events, second.state.events);
    assert.strictEqual(changed.battlefield.navigation, second.state.battlefield.navigation);
    assert.strictEqual(changed.battlefield.units, second.state.battlefield.units);
});

test("Projectile update retains omitted fields and returns the original BattleState for unchanged references", () => {
    const created = create();
    const original = projectiles.get(created.state, created.value);

    assert.strictEqual(projectiles.update(created.state, created.value, () => ({})), created.state);
    assert.strictEqual(projectiles.update(created.state, created.value, current => ({
        position: current.position, state: current.state,
    })), created.state);
    const moved = projectiles.update(created.state, created.value, () => ({ position: [1, 0] }));
    assert.strictEqual(projectiles.get(moved, created.value).state, original.state);
    const changed = projectiles.update(created.state, created.value, () => ({ state: { count: 1 } }));
    assert.strictEqual(projectiles.get(changed, created.value).position, original.position);
});

test("Projectile update skips missing instances without invoking the transform", () => {
    const created = create();
    const stopped = projectiles.stop(created.state, created.value);
    assert.strictEqual(projectiles.update(stopped, created.value, () => {
        assert.fail("missing Projectile must not invoke transform");
    }), stopped);
    assert.equal(projectiles.get(stopped, created.value), undefined);
});

test("Projectile update permits ENDING callbacks to publish cleanup and hit progress", () => {
    let observed;
    const definition = {
        id: "ending-update",
        onTerminate(battle, self) {
            assert.equal(self.lifecycle, "ENDING");
            const changed = projectiles.update(battle, projectiles.ref(self), current => ({
                position: [2, 0], state: { count: current.state.count + 1 },
            }));
            observed = projectiles.get(changed, projectiles.ref(self));
            assert.equal(observed.lifecycle, "ENDING");
            return changed;
        },
    };
    const created = projectiles.create(battle(), definition, { position: [0, 0], state: { count: 0 } });
    const stopped = projectiles.stop(created.state, created.value);

    assert.deepEqual(observed.state, { count: 1 });
    assert.deepEqual(observed.position, [2, 0]);
    assert.equal(projectiles.get(stopped, created.value), undefined);
    assert.deepEqual(projectiles.get(created.state, created.value).state, { count: 0 });
});

test("A throwing Projectile transform leaves the published instance and input BattleState intact", () => {
    const created = create();
    const original = projectiles.get(created.state, created.value);
    assert.throws(() => projectiles.update(created.state, created.value, () => {
        throw new Error("transform failed");
    }), /transform failed/);
    assert.strictEqual(projectiles.get(created.state, created.value), original);
    assert.deepEqual(original.state, { count: 0 });
});
