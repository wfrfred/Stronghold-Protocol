import { search as searchBlocking } from "../../dist/core/tactical/battle/blocking/operations.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRng } from "../../dist/core/common/rng.js";
import { hasCandidate, select } from "../../dist/core/tactical/battle/targeting/select.js";
import * as filters from "../../dist/core/tactical/battle/targeting/filter.js";
import * as selectors from "../../dist/core/tactical/battle/targeting/selector.js";
import * as compare from "../../dist/core/tactical/battle/targeting/compare.js";
import { ref } from "../../dist/core/tactical/unit/query.js";
import { createBattleState } from "../../dist/core/tactical/battle/state.js";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";
import { initialize } from "../helpers/unit.js";

const unit = (id, definitions = {}, states = {}) => initialize({
    id,
    position: [id, 0],
    definition: { id: `targeting-${id}`, ...definitions },
    states,
});
const target = (id, definitions = {}, states = {}) => unit(id, {
    targetable: { restrictions: [] }, ...definitions,
}, states);
const battle = (...units) => createBattleState(fixtureBattlefieldState(units));
const request = (source, options = {}) => ({
    source: ref(source),
    purposes: [],
    filter: () => true,
    selector: selectors.first(100, () => 0),
    ...options,
});

test("select enumerates Targetable and performs only the request's explicit filter", () => {
    const source = target(9);
    const leaving = { ...target(2), lifecycle: "LEAVING" };
    const configured = target(7, {
        targetable: { restrictions: [{
            id: "always-refuse", value: { kind: Symbol("untargetable"), allows: () => false },
        }] },
        vitality: { maxHp: 10, defense: 0, resistance: 0 },
    });
    const restricted = { ...configured, vitality: { ...configured.vitality, hp: 0 } };
    const initial = battle(source, unit(4), leaving, restricted);
    const selected = select(initial, request(source));

    assert.strictEqual(selected.state, initial);
    assert.deepEqual(selected.value, [{ id: 9 }, { id: 2 }, { id: 7 }]);
    assert.deepEqual(select(initial, request(source, {
        filter: (_battle, _request, candidate) => candidate.id === 7,
    })).value, [{ id: 7 }]);
});

test("filter and selector receive the same request, battle and filtered Unit snapshots", () => {
    const source = unit(0);
    const first = target(6);
    const second = target(3);
    const initial = battle(source, first, second);
    const seen = [];
    const query = request(source, {
        filter(current, input, candidate) {
            assert.strictEqual(current, initial);
            assert.strictEqual(input, query);
            seen.push(candidate);
            return candidate.id === 3;
        },
        selector(current, input, candidates) {
            assert.strictEqual(current, initial);
            assert.strictEqual(input, query);
            assert.deepEqual(candidates, [second]);
            assert.strictEqual(candidates[0], second);
            return { state: current, value: candidates.map(ref) };
        },
    });

    assert.deepEqual(select(initial, query).value, [{ id: 3 }]);
    assert.deepEqual(seen, [first, second]);
});

test("select still delegates an empty candidate collection to the selector", () => {
    const source = unit(0);
    const initial = battle(source);
    let calls = 0;
    const query = request(source, {
        selector(current, input, candidates) {
            calls++;
            assert.strictEqual(input, query);
            assert.deepEqual(candidates, []);
            return { state: current, value: [] };
        },
    });

    assert.deepEqual(select(initial, query), { state: initial, value: [] });
    assert.equal(calls, 1);
});

test("hasCandidate short-circuits explicit eligibility without invoking the selector or drawing RNG", () => {
    const source = unit(0);
    const initial = battle(source, target(3), target(4), target(5));
    const visited = [];
    const query = request(source, {
        filter(_battle, _request, candidate) {
            visited.push(candidate.id);
            return candidate.id === 4;
        },
        selector() {
            assert.fail("a candidate query must not invoke the selector");
        },
    });

    assert.equal(hasCandidate(initial, query), true);
    assert.deepEqual(visited, [3, 4]);
    assert.equal(initial.execution.rngState, 0);
    assert.equal(hasCandidate(initial, request(source, { filter: () => false })), false);
    assert.equal(hasCandidate(battle(source), query), false);
});

test("having an eligible candidate does not guarantee the selector returns a target", () => {
    const source = unit(0);
    const initial = battle(source, target(2));
    const query = request(source, { selector: selectors.random(0) });

    assert.equal(hasCandidate(initial, query), true);
    assert.deepEqual(select(initial, query).value, []);
    assert.strictEqual(select(initial, query).state, initial);
});

test("first performs stable multi-level sorting without consuming RNG", () => {
    const source = unit(0);
    const initial = battle(source, target(8), target(2), target(5));
    const query = request(source, {
        selector: selectors.first(2, compare.combine(() => 0, () => 0)),
    });

    assert.deepEqual(select(initial, query).value, [{ id: 8 }, { id: 2 }]);
    assert.strictEqual(select(initial, query).state, initial);
    assert.deepEqual(select(initial, request(source, {
        selector: selectors.first(2, compare.distance),
    })).value, [{ id: 2 }, { id: 5 }]);
});

test("random samples without replacement, consumes battle RNG and preserves the input", () => {
    const source = unit(0);
    const initial = battle(source, target(8), target(2), target(5));
    const seeded = { ...initial, execution: { ...initial.execution, rngState: 37 } };
    const query = request(source, { selector: selectors.random(2) });
    const selected = select(seeded, query);
    const expectedRng = createRng(37);
    const pool = [8, 2, 5];

    for (let index = 0; index < 2; index++) {
        const chosen = index + expectedRng.int(pool.length - index);
        [pool[index], pool[chosen]] = [pool[chosen], pool[index]];
    }

    assert.deepEqual(selected.value.map(value => value.id), pool.slice(0, 2));
    assert.equal(new Set(selected.value.map(value => value.id)).size, 2);
    assert.equal(selected.state.execution.rngState, expectedRng.state());
    assert.equal(seeded.execution.rngState, 37);
    assert.strictEqual(selected.state.battlefield, seeded.battlefield);
    assert.deepEqual(select(seeded, query), selected);
    assert.notEqual(select(selected.state, query).state.execution.rngState, selected.state.execution.rngState);
});

test("random returns every candidate at most once and does not draw from an empty sample", () => {
    const source = unit(0);
    const initial = battle(source, target(4), target(5));
    const full = select(initial, request(source, { selector: selectors.random(10) }));

    assert.deepEqual(full.value.map(value => value.id).sort(), [4, 5]);
    assert.strictEqual(select(initial, request(source, { selector: selectors.random(0) })).state, initial);
    const empty = battle(source);
    assert.strictEqual(select(empty, request(source, { selector: selectors.random(2) })).state, empty);
});

test("standard filters compose eligibility and source exclusion explicitly", () => {
    const source = target(0, { allegiance: { side: "ALLY" } });
    const alive = target(1, { allegiance: { side: "ENEMY" }, vitality: { maxHp: 10, defense: 0, resistance: 0 } });
    const dead = target(2, { allegiance: { side: "ENEMY" }, vitality: { maxHp: 10, defense: 0, resistance: 0 } });
    const initial = battle(source, alive, { ...dead, vitality: { ...dead.vitality, hp: 0 } });

    assert.deepEqual(select(initial, request(source, {
        filter: filters.and(filters.present, filters.alive, filters.hostile, filters.notSelf),
    })).value, [{ id: 1 }]);
    assert.deepEqual(select(initial, request(source, {
        filter: filters.not(filters.or(filters.alive, filters.sameSide)),
    })).value, [{ id: 2 }]);
});

test("blockedFirst preserves blocking relation order and then uses the next comparator", () => {
    const source = unit(0, {
        allegiance: { side: "ALLY" }, blocker: { capacity: 2, geometry: { radius: 1 } },
    });
    const definition = {
        allegiance: { side: "ENEMY" }, blockable: { volume: 1 }, layer: { type: "GROUND" },
    };
    const initial = battle(source, target(1),
        { ...target(2, definition), position: [0.5, 0] },
        { ...target(3, definition), position: [0.25, 0] }, target(4));
    const current = searchBlocking(initial, ref(source));

    assert.deepEqual(select(current, request(source, {
        selector: selectors.first(4, compare.combine(compare.blockedFirst, compare.distance)),
    })).value, [{ id: 3 }, { id: 2 }, { id: 1 }, { id: 4 }]);
    assert.deepEqual(select(current, request(source, { filter: filters.blocking })).value,
        [{ id: 2 }, { id: 3 }]);
});
