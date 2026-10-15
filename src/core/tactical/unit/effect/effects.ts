import type { Definition } from "./definition.js";
import type { Effect, Id } from "./effect.js";

type StoredEffect = Omit<Effect, "definition" | "data"> & {
    readonly definition: Pick<Effect["definition"], "id" | "group">;
    readonly data: object;
};

export class Effects {
    static readonly #empty = new Effects([], 0);

    readonly #entries: readonly StoredEffect[];
    readonly nextId: Id;

    private constructor(entries: readonly StoredEffect[], nextId: Id) {
        this.#entries = entries;
        this.nextId = nextId;
    }

    static empty(): Effects {
        return Effects.#empty;
    }

    get(id: Id): StoredEffect | undefined;
    get<S extends object, H extends object>(
        id: Id,
        definition: Definition<S, H>,
    ): Effect<S, H> | undefined;
    get<S extends object, H extends object>(
        id: Id,
        definition?: Definition<S, H>,
    ): StoredEffect | Effect<S, H> | undefined {
        const effect = this.#entries.find((entry) => entry.id === id);

        if (definition === undefined) {
            return effect;
        }

        const restored: Effect<S, H> | undefined =
            effect?.definition === definition ? (effect as Effect<S, H>) : undefined;

        return restored;
    }

    read<R>(
        id: Id,
        reader: <S extends object, H extends object>(effect: Effect<S, H>) => R,
    ): R | undefined {
        const effect = this.#entries.find((entry) => entry.id === id);

        return effect === undefined ? undefined : reader(effect as Effect);
    }

    values(): readonly StoredEffect[] {
        return this.#entries;
    }

    add<S extends object, H extends object>(effect: Effect<S, H>): Effects {
        if (effect.id !== this.nextId) {
            throw new RangeError("invalid effect identity");
        }

        const nextId = this.nextId + 1;

        if (!Number.isSafeInteger(nextId)) {
            throw new RangeError("effect identity overflow");
        }

        return new Effects([...this.#entries, effect], nextId);
    }

    replace<S extends object, H extends object>(effect: Effect<S, H>): Effects {
        const index = this.#entries.findIndex((entry) => entry.id === effect.id);

        if (index < 0) {
            return this;
        }

        const previous = this.#entries[index]!;

        if (previous.definition !== effect.definition) {
            throw new TypeError("effect definition cannot change");
        }
        if (previous.host.id !== effect.host.id) {
            throw new TypeError("effect host cannot change");
        }
        if (previous === effect) {
            return this;
        }

        return new Effects(
            [...this.#entries.slice(0, index), effect, ...this.#entries.slice(index + 1)],
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

    toJSON(): { readonly instances: readonly StoredEffect[]; readonly nextId: Id } {
        return { instances: this.#entries, nextId: this.nextId };
    }
}
