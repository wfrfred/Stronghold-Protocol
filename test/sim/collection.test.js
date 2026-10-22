import assert from "node:assert/strict";
import { test } from "node:test";
import { sort, topK } from "../../dist/core/common/collection.js";
import { create } from "../../dist/core/common/query.js";

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

test("sort and topK accept iterable queries without changing stable tie order", () => {
    const candidates = [
        { id: "a", value: 2 },
        { id: "b", value: 1 },
        { id: "c", value: 2 },
        { id: "d", value: 1 },
    ];
    const query = create(() => candidates[Symbol.iterator]()).filter(value => value.id !== "c");
    const compare = (left, right) => left.value - right.value;

    assert.deepEqual(sort(query, compare).map(value => value.id), ["b", "d", "a"]);
    assert.deepEqual(topK(query, 2, compare).map(value => value.id), ["b", "d"]);
    assert.deepEqual(topK(new Set([3, 1, 2]), 9, (left, right) => left - right), [1, 2, 3]);
});

test("topK skips the source entirely for zero and processes it incrementally otherwise", () => {
    const unavailable = {
        [Symbol.iterator]() {
            throw new Error("source opened");
        },
    };

    assert.deepEqual(topK(unavailable, 0, () => 0), []);

    const consumed = [];
    const comparisons = [];
    const candidates = {
        *[Symbol.iterator]() {
            for (const value of [9, 3, 7, 1, 5]) {
                consumed.push(value);
                yield value;
            }
        },
    };
    const best = topK(candidates, 2, (left, right) => {
        comparisons.push(consumed.length);
        return left - right;
    });

    assert.deepEqual(best, [1, 3]);
    assert.deepEqual(consumed, [9, 3, 7, 1, 5]);
    assert.equal(comparisons[0], 2);

    for (const k of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => topK(unavailable, k, () => 0), RangeError);
    }
});

test("topK closes an iterable source if its comparator throws", () => {
    let closed = false;
    const failure = new Error("comparison failed");
    const candidates = {
        *[Symbol.iterator]() {
            try {
                yield 3;
                yield 2;
                yield 1;
            } finally {
                closed = true;
            }
        },
    };

    assert.throws(() => topK(candidates, 2, () => { throw failure; }), error => error === failure);
    assert.equal(closed, true);
});
