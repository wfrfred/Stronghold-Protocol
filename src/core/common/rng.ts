import { assertNonnegativeNumber, assertPositiveNumber } from "./assert.js";

export type Seed = number;

const UINT32_RANGE = 2 ** 32;

export type NonEmptyArray<T> = readonly [T, ...T[]];

export interface Rng {
    /** @returns [0, 1). */
    next(): number;

    /**
     * @param upper Integer in [1, 2 ** 32].
     * @returns Integer in [0, upper).
     * @throws {RangeError} Invalid upper bound.
     */
    int(upper: number): number;
    /**
     * @param lower Safe integer less than upper.
     * @param upper Safe integer greater than lower.
     * Range width must not exceed 2 ** 32.
     * @returns Integer in [lower, upper).
     * @throws {RangeError} Invalid bounds.
     */
    int(lower: number, upper: number): number;

    /**
     * @param probability Finite number in [0, 1].
     * @throws {RangeError} Invalid probability.
     */
    chance(probability: number): boolean;

    pick<T>(items: NonEmptyArray<T>): T;
    /**
     * Weights must be finite and non-negative; their sum must be finite and positive.
     * @throws {RangeError} Invalid weights or sum.
     */
    weighted<T>(items: NonEmptyArray<readonly [T, number]>): T;

    /** Does not modify the input array. */
    shuffle<T>(arr: readonly T[]): T[];

    /** @returns Current internal state. */
    state(): Seed;
}

/**
 * @param seed Integer in [0, 2 ** 32), including a saved state.
 * @throws {RangeError} Invalid seed.
 */
export function createRng(seed: Seed): Rng {
    if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
        throw new RangeError("seed must be an unsigned 32-bit integer");
    }

    let rngState = seed >>> 0;

    function next(): number {
        rngState = (rngState + 0x6d2b79f5) >>> 0;
        let t = rngState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    }

    function int(a: number, b?: number): number {
        const lower = b === undefined ? 0 : a;
        let upper = a;

        if (b !== undefined) {
            upper = b;
        }

        if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower >= upper) {
            throw new RangeError(`invalid integer range [${lower}, ${upper})`);
        }

        const width = upper - lower;

        if (width > UINT32_RANGE) {
            throw new RangeError("integer range width must not exceed 2 ** 32");
        }

        return lower + Math.floor(next() * width);
    }

    function chance(probability: number): boolean {
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
            throw new RangeError("probability must be a finite number in [0, 1]");
        }

        return next() < probability;
    }

    function pick<T>(items: NonEmptyArray<T>): T {
        return items[int(items.length)]!;
    }

    function weighted<T>(items: NonEmptyArray<readonly [T, number]>): T {
        let total = 0;
        let lastPositive: T | undefined;

        for (const [item, weight] of items) {
            assertNonnegativeNumber(weight, "weight");

            if (weight > 0) {
                lastPositive = item;
            }

            total += weight;
        }

        assertPositiveNumber(total, "total weight");

        let target = next() * total;

        for (const [item, weight] of items) {
            target -= weight;

            if (target < 0) {
                return item;
            }
        }

        return lastPositive!;
    }

    function shuffle<T>(arr: readonly T[]): T[] {
        const result = [...arr];

        for (let i = result.length - 1; i > 0; i--) {
            const j = int(i + 1);
            const tmp = result[i]!;

            result[i] = result[j]!;
            result[j] = tmp;
        }

        return result;
    }

    return {
        next,
        int,
        chance,
        pick,
        weighted,
        shuffle,
        state() {
            return rngState;
        },
    };
}
