import type { Definition } from "./definition.js";
import type { Effect, Id } from "./effect.js";

export class Effects {
    static readonly #empty = new Effects([], 0);

    readonly #entries: readonly Effect[];
    readonly nextId: Id;

    private constructor(entries: readonly Effect[], nextId: Id) {
        this.#entries = entries;
        this.nextId = nextId;
    }

    static empty(): Effects {
        return Effects.#empty;
    }

    get(id: Id): Effect | undefined;
    get<S extends object, H extends object>(
        id: Id,
        definition: Definition<S, H>,
    ): Effect<S, H> | undefined;
    get<S extends object, H extends object>(
        id: Id,
        definition?: Definition<S, H>,
    ): Effect<S, H> | undefined {
        const effect = this.#entries.find((entry) => entry.id === id);

        return definition === undefined || effect?.definition === (definition as object)
            ? (effect as Effect<S, H> | undefined)
            : undefined;
    }

    values(): readonly Effect[] {
        return this.#entries;
    }

    add<S extends object, H extends object>(effect: Effect<S, H>): Effects {
        const nextId = effect.id + 1;

        if (!Number.isSafeInteger(nextId)) {
            throw new RangeError("effect identity overflow");
        }

        return new Effects(
            [...this.#entries, effect as unknown as Effect],
            Math.max(this.nextId, nextId),
        );
    }

    replace<S extends object, H extends object>(effect: Effect<S, H>): Effects {
        const entry = effect as unknown as Effect;
        const index = this.#entries.findIndex((entry) => entry.id === effect.id);

        if (index < 0 || this.#entries[index] === entry) {
            return this;
        }

        return new Effects(
            [...this.#entries.slice(0, index), entry, ...this.#entries.slice(index + 1)],
            this.nextId,
        );
    }

    remove(id: Id): Effects {
        const index = this.#entries.findIndex((entry) => entry.id === id);

        return index < 0
            ? this
            : new Effects(
                  [...this.#entries.slice(0, index), ...this.#entries.slice(index + 1)],
                  this.nextId,
              );
    }

    toJSON(): { readonly instances: readonly Effect[]; readonly nextId: Id } {
        return { instances: this.#entries, nextId: this.nextId };
    }
}
