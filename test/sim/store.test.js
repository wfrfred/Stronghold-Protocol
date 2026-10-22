import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../dist/core/common/collection/store.js";

test("store updates preserve preceding versions and reject duplicate or missing entries", () => {
    const empty = Store.empty();
    const first = empty.add("first", 1);
    const added = first.add("second", 2);
    const replaced = added.replace("first", 3);
    const removed = replaced.remove("second");

    assert.equal(empty.size, 0);
    assert.equal(empty.get("first"), undefined);
    assert.deepEqual(empty.keys().toArray(), []);
    assert.deepEqual(empty.values().toArray(), []);
    assert.deepEqual(first.values().toArray(), [1]);
    assert.deepEqual(added.values().toArray(), [1, 2]);
    assert.deepEqual(replaced.values().toArray(), [3, 2]);
    assert.deepEqual(removed.values().toArray(), [3]);
    assert.equal(added.size, 2);
    assert.equal(removed.size, 1);
    assert.equal(added.get("first"), 1);
    assert.equal(replaced.get("first"), 3);
    assert.equal(removed.get("second"), undefined);

    assert.throws(() => added.add("first", 99), RangeError);
    assert.throws(() => added.replace("missing", 99), RangeError);
    assert.throws(() => added.remove("missing"), RangeError);
    assert.deepEqual(added.keys().toArray(), ["first", "second"]);
    assert.deepEqual(added.values().toArray(), [1, 2]);
    assert.equal(added.size, 2);
});

test("replacement retains registration order while removal and readdition append at the end", () => {
    const original = Store.empty().add("a", 1).add("b", 2).add("c", 3);
    const replaced = original.replace("b", 20);
    const readded = replaced.remove("b").add("b", 200);

    assert.deepEqual(replaced.keys().toArray(), ["a", "b", "c"]);
    assert.deepEqual(replaced.values().toArray(), [1, 20, 3]);
    assert.deepEqual(readded.keys().toArray(), ["a", "c", "b"]);
    assert.deepEqual(readded.values().toArray(), [1, 3, 200]);
    assert.deepEqual(original.values().toArray(), [1, 2, 3]);
});

test("key and value queries remain bound to their old version and evaluate lazily on every traversal", () => {
    const original = Store.empty().add("first", 1).add("second", 2);
    const observed = [];
    const keys = original.keys();
    const values = original.values().map(value => {
        observed.push(value);
        return value * 10;
    });
    const changed = original.replace("first", 100).remove("second").add("third", 3);

    assert.deepEqual(observed, []);
    assert.deepEqual(values.take(1).toArray(), [10]);
    assert.deepEqual(observed, [1]);
    assert.deepEqual(values.toArray(), [10, 20]);
    assert.deepEqual(values.toArray(), [10, 20]);
    assert.deepEqual(observed, [1, 1, 2, 1, 2]);
    assert.deepEqual(keys.toArray(), ["first", "second"]);
    assert.deepEqual(keys.toArray(), ["first", "second"]);
    assert.deepEqual(changed.keys().toArray(), ["first", "third"]);
    assert.deepEqual(changed.values().toArray(), [100, 3]);
});

test("undefined is a stored value rather than an absent entry", () => {
    const original = Store.empty().add("present", undefined);

    assert.equal(original.size, 1);
    assert.equal(original.get("present"), undefined);
    assert.deepEqual(original.keys().toArray(), ["present"]);
    assert.deepEqual(original.values().toArray(), [undefined]);
    assert.throws(() => original.add("present", "duplicate"), RangeError);
    assert.strictEqual(original.replace("present", undefined), original);

    const replaced = original.replace("present", "defined");
    const removed = original.remove("present");

    assert.equal(replaced.get("present"), "defined");
    assert.equal(replaced.size, 1);
    assert.equal(removed.size, 0);
    assert.deepEqual(removed.keys().toArray(), []);
    assert.equal(removed.add("present", undefined).size, 1);
    assert.throws(() => removed.replace("present", undefined), RangeError);
    assert.throws(() => removed.remove("present"), RangeError);
    assert.deepEqual(original.values().toArray(), [undefined]);
});

test("object keys are identified by reference rather than their contents", () => {
    const left = { id: 1 };
    const right = { id: 1 };
    const original = Store.empty().add(left, "left").add(right, "right");

    assert.equal(original.size, 2);
    assert.equal(original.get(left), "left");
    assert.equal(original.get(right), "right");
    assert.equal(original.get({ id: 1 }), undefined);
    assert.throws(() => original.add(left, "duplicate"), RangeError);

    const replaced = original.replace(left, "changed");
    const remaining = replaced.remove(right);

    assert.equal(replaced.get(left), "changed");
    assert.equal(replaced.get(right), "right");
    assert.strictEqual(replaced.keys().toArray()[0], left);
    assert.strictEqual(replaced.keys().toArray()[1], right);
    assert.equal(remaining.size, 1);
    assert.equal(remaining.get(right), undefined);
    assert.equal(original.get(left), "left");
});

test("numeric keys treat NaN as equal to itself and positive and negative zero as one key", () => {
    const original = Store.empty().add(NaN, "nan").add(-0, "zero");

    assert.equal(original.get(Number("not-a-number")), "nan");
    assert.equal(original.get(+0), "zero");
    assert.equal(original.get(-0), "zero");
    assert.throws(() => original.add(NaN, "duplicate"), RangeError);
    assert.throws(() => original.add(+0, "duplicate"), RangeError);

    const replaced = original.replace(NaN, "changed nan").replace(+0, "changed zero");
    const remaining = replaced.remove(-0);

    assert.equal(replaced.size, 2);
    assert.equal(replaced.get(NaN), "changed nan");
    assert.equal(replaced.get(-0), "changed zero");
    assert.deepEqual(replaced.values().toArray(), ["changed nan", "changed zero"]);
    assert.equal(remaining.size, 1);
    assert.deepEqual(remaining.keys().toArray(), [NaN]);
    assert.equal(remaining.remove(NaN).size, 0);
    assert.deepEqual(original.values().toArray(), ["nan", "zero"]);
});

test("replacement shares the store for Object.is equal values and distinguishes signed zero values", () => {
    const object = { value: 1 };
    const original = Store.empty().add("object", object).add("nan", NaN).add("zero", +0);

    assert.strictEqual(original.replace("object", object), original);
    assert.strictEqual(original.replace("nan", NaN), original);
    assert.strictEqual(original.replace("zero", +0), original);

    const otherObject = { value: 1 };
    const replacedObject = original.replace("object", otherObject);
    const negative = original.replace("zero", -0);
    const positive = negative.replace("zero", +0);

    assert.notStrictEqual(replacedObject, original);
    assert.strictEqual(replacedObject.get("object"), otherObject);
    assert.strictEqual(original.get("object"), object);
    assert.notStrictEqual(negative, original);
    assert.equal(Object.is(negative.get("zero"), -0), true);
    assert.equal(Object.is(original.get("zero"), +0), true);
    assert.strictEqual(negative.replace("zero", -0), negative);
    assert.notStrictEqual(positive, negative);
    assert.equal(Object.is(positive.get("zero"), +0), true);
});

test("stored objects retain their identity without cloning or freezing their nested values", () => {
    const value = { nested: { amount: 1 } };
    const original = Store.empty().add("value", value);

    assert.strictEqual(original.get("value"), value);
    assert.strictEqual(original.values().toArray()[0], value);
    assert.equal(Object.isFrozen(value), false);
    assert.equal(Object.isFrozen(value.nested), false);

    const replacement = { nested: { amount: 2 } };
    const changed = original.replace("value", replacement);

    assert.strictEqual(changed.get("value"), replacement);
    assert.strictEqual(changed.get("value").nested, replacement.nested);
    assert.equal(Object.isFrozen(replacement), false);
    assert.equal(Object.isFrozen(replacement.nested), false);
    assert.strictEqual(original.get("value"), value);
});
