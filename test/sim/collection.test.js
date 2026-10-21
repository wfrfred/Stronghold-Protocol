import assert from "node:assert/strict";
import { test } from "node:test";
import { sort, topK } from "../../dist/core/common/collection.js";

test("sort leaves its input intact and preserves the order of equal values", () => {
    const candidates = Object.freeze([
        { id: "a", value: 2 },
        { id: "b", value: 1 },
        { id: "c", value: 2 },
        { id: "d", value: 1 },
    ]);
    const sorted = sort(candidates, (left, right) => left.value - right.value);

    assert.deepEqual(sorted.map(value => value.id), ["b", "d", "a", "c"]);
    assert.deepEqual(candidates.map(value => value.id), ["a", "b", "c", "d"]);
    assert.notStrictEqual(sorted, candidates);
});

test("topK matches stable sorted prefixes at every boundary and in both orders", () => {
    const candidates = Object.freeze(Array.from({ length: 73 }, (_, index) => ({
        id: index,
        value: (index * 19 + 7) % 11,
    })));
    const ascending = (left, right) => left.value - right.value;
    const descending = (left, right) => right.value - left.value;

    for (const compare of [ascending, descending, () => 0]) {
        for (let k = 0; k <= candidates.length + 2; k++) {
            assert.deepEqual(topK(candidates, k, compare), [...candidates].sort(compare).slice(0, k));
        }
    }

    assert.deepEqual(candidates.map(value => value.id), Array.from({ length: 73 }, (_, index) => index));
    assert.deepEqual(topK([], 4, ascending), []);
});

test("topK retains the earlier candidate when the cutoff crosses equal values", () => {
    const candidates = [
        { id: "first", value: 3 },
        { id: "best", value: 1 },
        { id: "second", value: 3 },
        { id: "middle", value: 2 },
        { id: "third", value: 3 },
    ];

    assert.deepEqual(topK(candidates, 3, (left, right) => left.value - right.value).map(value => value.id),
        ["best", "middle", "first"]);
});
