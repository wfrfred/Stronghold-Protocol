import * as query from "../query.js";

export class Store<K, V> {
    readonly #entries: ReadonlyMap<K, V>;

    private constructor(entries: ReadonlyMap<K, V>) {
        this.#entries = entries;
    }

    static empty<K, V>(): Store<K, V> {
        return new Store(new Map<K, V>());
    }

    get size(): number {
        return this.#entries.size;
    }

    get(key: K): V | undefined {
        return this.#entries.get(key);
    }

    keys(): query.Query<K> {
        return query.create(() => this.#entries.keys());
    }

    values(): query.Query<V> {
        return query.create(() => this.#entries.values());
    }

    add(key: K, value: V): Store<K, V> {
        if (this.#entries.has(key)) {
            throw new RangeError("duplicate store key");
        }

        const entries = new Map(this.#entries);
        entries.set(key, value);

        return new Store(entries);
    }

    replace(key: K, value: V): Store<K, V> {
        if (!this.#entries.has(key)) {
            throw new RangeError("unknown store key");
        }
        if (Object.is(this.#entries.get(key), value)) {
            return this;
        }

        const entries = new Map(this.#entries);
        entries.set(key, value);

        return new Store(entries);
    }

    remove(key: K): Store<K, V> {
        if (!this.#entries.has(key)) {
            throw new RangeError("unknown store key");
        }

        const entries = new Map(this.#entries);
        entries.delete(key);

        return new Store(entries);
    }
}
