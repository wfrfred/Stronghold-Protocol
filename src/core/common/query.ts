import { assertNonnegativeSafeInteger } from "./assert.js";

export interface Query<T> extends Iterable<T> {
    filter<S extends T>(guard: (value: T) => value is S): Query<S>;
    filter(predicate: (value: T) => boolean): Query<T>;
    map<R>(project: (value: T) => R): Query<R>;
    flatMap<R>(project: (value: T) => Iterable<R>): Query<R>;
    take(count: number): Query<T>;
    some(predicate: (value: T) => boolean): boolean;
    find<S extends T>(guard: (value: T) => value is S): S | undefined;
    find(predicate: (value: T) => boolean): T | undefined;
    reduce<R>(reducer: (accumulator: R, value: T) => R, initial: R): R;
    toArray(): readonly T[];
}

class Sequence<T> implements Query<T> {
    readonly #iterate: () => Iterator<T>;

    constructor(iterate: () => Iterator<T>) {
        this.#iterate = iterate;
    }

    [Symbol.iterator](): Iterator<T> {
        return this.#iterate();
    }

    filter<S extends T>(guard: (value: T) => value is S): Query<S>;
    filter(predicate: (value: T) => boolean): Query<T>;
    filter(predicate: (value: T) => boolean): Query<T> {
        return create(() => filter(this, predicate));
    }

    map<R>(project: (value: T) => R): Query<R> {
        return create(() => map(this, project));
    }

    flatMap<R>(project: (value: T) => Iterable<R>): Query<R> {
        return create(() => flatMap(this, project));
    }

    take(count: number): Query<T> {
        assertNonnegativeSafeInteger(count, "count");

        return create(() => take(this, count));
    }

    some(predicate: (value: T) => boolean): boolean {
        for (const value of this) {
            if (predicate(value)) {
                return true;
            }
        }

        return false;
    }

    find<S extends T>(guard: (value: T) => value is S): S | undefined;
    find(predicate: (value: T) => boolean): T | undefined;
    find(predicate: (value: T) => boolean): T | undefined {
        for (const value of this) {
            if (predicate(value)) {
                return value;
            }
        }

        return undefined;
    }

    reduce<R>(reducer: (accumulator: R, value: T) => R, initial: R): R {
        let result = initial;

        for (const value of this) {
            result = reducer(result, value);
        }

        return result;
    }

    toArray(): readonly T[] {
        return [...this];
    }
}

export function create<T>(iterate: () => Iterator<T>): Query<T> {
    return new Sequence(iterate);
}

function* filter<T>(source: Iterable<T>, predicate: (value: T) => boolean): Generator<T> {
    for (const value of source) {
        if (predicate(value)) {
            yield value;
        }
    }
}

function* map<T, R>(source: Iterable<T>, project: (value: T) => R): Generator<R> {
    for (const value of source) {
        yield project(value);
    }
}

function* flatMap<T, R>(source: Iterable<T>, project: (value: T) => Iterable<R>): Generator<R> {
    for (const value of source) {
        yield* project(value);
    }
}

function* take<T>(source: Iterable<T>, count: number): Generator<T> {
    if (count === 0) {
        return;
    }

    let remaining = count;

    for (const value of source) {
        yield value;
        remaining--;

        if (remaining === 0) {
            return;
        }
    }
}
