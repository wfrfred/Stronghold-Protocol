import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "../../dist/core/common/query.js";

function tracked(values) {
    const state = { opened: 0, read: [], closed: 0 };
    const query = create(function* () {
        state.opened++;

        try {
            for (const value of values) {
                state.read.push(value);
                yield value;
            }
        } finally {
            state.closed++;
        }
    });

    return { query, state };
}

test("query pipelines are lazy, ordered and repeatable without caching", () => {
    const { query, state } = tracked([1, 2, 3, 4]);
    const calls = [];
    const selected = query
        .filter(value => {
            calls.push(`first:${value}`);
            return value % 2 === 0;
        })
        .filter(value => {
            calls.push(`second:${value}`);
            return value > 2;
        })
        .map(value => {
            calls.push(`map:${value}`);
            return { value };
        });

    assert.deepEqual(state, { opened: 0, read: [], closed: 0 });
    assert.deepEqual(calls, []);

    const first = selected.toArray();
    const expectedCalls = ["first:1", "first:2", "second:2", "first:3", "first:4", "second:4", "map:4"];

    assert.deepEqual(first, [{ value: 4 }]);
    assert.deepEqual(calls, expectedCalls);
    assert.deepEqual(selected.toArray(), first);
    assert.deepEqual(calls, [...expectedCalls, ...expectedCalls]);
    assert.notStrictEqual(selected.toArray()[0], first[0]);
    assert.deepEqual(query.toArray(), [1, 2, 3, 4]);
});

test("simultaneous cursors and a short-circuited traversal keep independent progress", () => {
    const { query, state } = tracked([1, 2, 3]);
    const left = query.map(value => value * 10)[Symbol.iterator]();
    const right = query[Symbol.iterator]();

    assert.deepEqual(left.next(), { value: 10, done: false });
    assert.deepEqual(left.next(), { value: 20, done: false });
    assert.deepEqual(right.next(), { value: 1, done: false });
    left.return();
    assert.deepEqual(right.next(), { value: 2, done: false });
    right.return();
    assert.equal(state.closed, 2);

    assert.equal(query.some(value => value === 2), true);
    assert.deepEqual(query.toArray(), [1, 2, 3]);
    assert.equal(state.closed, 4);
});

test("create accepts plain iterator factories and closes them on short circuit", () => {
    let closed = 0;
    const query = create(() => {
        let current = 0;

        return {
            next() {
                current++;
                return current <= 3 ? { value: current, done: false } : { done: true };
            },
            return() {
                closed++;
                return { done: true };
            },
        };
    });

    assert.equal(query.find(value => value === 2), 2);
    assert.equal(closed, 1);
    assert.deepEqual(query.toArray(), [1, 2, 3]);
    assert.equal(closed, 1);
});

test("take zero never opens its source and positive take reads exactly its budget", () => {
    let factories = 0;
    const query = create(() => {
        factories++;
        return [1, 2, 3][Symbol.iterator]();
    });

    assert.deepEqual(query.take(0).toArray(), []);
    assert.equal(factories, 0);

    const source = tracked([1, 2, 3]);

    assert.deepEqual(source.query.take(2).toArray(), [1, 2]);
    assert.deepEqual(source.state, { opened: 1, read: [1, 2], closed: 1 });
    assert.deepEqual(source.query.take(9).toArray(), [1, 2, 3]);

    for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => query.take(count), RangeError);
    }
});

test("some and find stop reading when they find their result", () => {
    const source = tracked([1, 2, 3, 4]);

    assert.equal(source.query.some(value => value === 2), true);
    assert.deepEqual(source.state.read, [1, 2]);
    assert.equal(source.state.closed, 1);
    assert.equal(source.query.find(value => value > 2), 3);
    assert.deepEqual(source.state.read, [1, 2, 1, 2, 3]);
    assert.equal(source.state.closed, 2);
    assert.equal(source.query.some(value => value > 4), false);
    assert.equal(source.query.find(value => value > 4), undefined);
});

test("flatMap preserves nested order and closes both cursors on early exit", () => {
    const outer = tracked([1, 2, 3]);
    const inner = tracked(["a", "b", "c"]);
    const flattened = outer.query.flatMap(number => inner.query.map(letter => `${number}${letter}`));

    assert.deepEqual(flattened.take(2).toArray(), ["1a", "1b"]);
    assert.deepEqual(outer.state, { opened: 1, read: [1], closed: 1 });
    assert.deepEqual(inner.state, { opened: 1, read: ["a", "b"], closed: 1 });
    assert.deepEqual(flattened.toArray(), ["1a", "1b", "1c", "2a", "2b", "2c", "3a", "3b", "3c"]);
    assert.deepEqual(outer.query.flatMap(value => value === 2 ? [] : [value, -value]).toArray(), [1, -1, 3, -3]);
});

test("consumer break and callback exceptions close every active cursor", () => {
    const broken = tracked([1, 2, 3]);

    for (const value of broken.query) {
        assert.equal(value, 1);
        break;
    }

    assert.equal(broken.state.closed, 1);

    const failure = new Error("callback failed");

    for (const consume of [
        query => query.filter(() => { throw failure; }).toArray(),
        query => query.map(() => { throw failure; }).toArray(),
        query => query.flatMap(() => { throw failure; }).toArray(),
        query => query.some(() => { throw failure; }),
        query => query.find(() => { throw failure; }),
        query => query.reduce(() => { throw failure; }, 0),
    ]) {
        const source = tracked([1, 2]);

        assert.throws(() => consume(source.query), error => error === failure);
        assert.deepEqual(source.state, { opened: 1, read: [1], closed: 1 });
    }

    const outer = tracked([1, 2]);
    const inner = tracked(["a", "b"]);
    const flattened = outer.query.flatMap(() => inner.query).map(() => { throw failure; });

    assert.throws(() => flattened.toArray(), error => error === failure);
    assert.equal(outer.state.closed, 1);
    assert.equal(inner.state.closed, 1);
});

test("empty sequences retain terminal identities and reductions preserve order", () => {
    const empty = create(() => [][Symbol.iterator]());
    const fail = () => { throw new Error("empty sequence callback invoked"); };
    const initial = { unchanged: true };

    assert.deepEqual(empty.filter(fail).map(fail).flatMap(fail).take(3).toArray(), []);
    assert.equal(empty.some(fail), false);
    assert.equal(empty.find(fail), undefined);
    assert.strictEqual(empty.reduce(fail, initial), initial);
    assert.equal(create(() => [3, 1, 2][Symbol.iterator]()).reduce((text, value) => text + value, "="), "=312");
});
