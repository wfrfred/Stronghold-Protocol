import test from 'node:test';
import nodeAssert from 'node:assert/strict';
import {
    assert,
    assertFiniteNumber,
    assertNonnegativeNumber,
    assertPositiveNumber,
    assertSafeInteger,
    assertNonnegativeSafeInteger,
    assertPositiveSafeInteger,
} from '../../dist/core/common/assert.js';

const validators = [
    assertFiniteNumber,
    assertNonnegativeNumber,
    assertPositiveNumber,
    assertSafeInteger,
    assertNonnegativeSafeInteger,
    assertPositiveSafeInteger,
];

test('numeric assertions reject non-numeric and non-finite boundary input without coercion', () => {
    for (const validate of validators) {
        for (const value of [undefined, null, '1', true, {}, [], 1n, Symbol(), NaN, Infinity, -Infinity]) {
            nodeAssert.throws(() => validate(value, 'input'), RangeError);
        }
    }
});

test('number and safe-integer assertions keep their distinct sign and precision limits', () => {
    const cases = [
        [assertFiniteNumber, [-Number.MAX_VALUE, -0.5, -0, 0, 0.5, Number.MAX_VALUE], []],
        [assertNonnegativeNumber, [-0, 0, 0.5, Number.MAX_VALUE], [-1, -0.5]],
        [assertPositiveNumber, [Number.MIN_VALUE, 0.5, Number.MAX_VALUE], [-1, -0, 0]],
        [assertSafeInteger, [Number.MIN_SAFE_INTEGER, -1, -0, 0, Number.MAX_SAFE_INTEGER], [-0.5, 0.5, Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1]],
        [assertNonnegativeSafeInteger, [-0, 0, Number.MAX_SAFE_INTEGER], [-1, -0.5, 0.5, Number.MAX_SAFE_INTEGER + 1]],
        [assertPositiveSafeInteger, [1, Number.MAX_SAFE_INTEGER], [-1, -0, 0, 0.5, Number.MAX_SAFE_INTEGER + 1]],
    ];

    for (const [validate, accepted, rejected] of cases) {
        for (const value of accepted) {
            nodeAssert.doesNotThrow(() => validate(value, 'input'));
        }
        for (const value of rejected) {
            nodeAssert.throws(() => validate(value, 'input'), RangeError);
        }
    }
});

test('assertion failures keep the caller label and chosen exception type', () => {
    for (const validate of validators) {
        nodeAssert.throws(() => validate(null, 'snapshot.id', TypeError), {
            name: 'TypeError',
            message: /^snapshot\.id must be /,
        });
    }

    nodeAssert.doesNotThrow(() => assert(true, 'valid'));
    nodeAssert.throws(() => assert(false, 'invalid'), { name: 'Error', message: 'invalid' });
    nodeAssert.throws(() => assert(false, 'invalid range', RangeError), {
        name: 'RangeError',
        message: 'invalid range',
    });
});
