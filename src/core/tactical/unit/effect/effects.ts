import { Store } from "../../../common/collection/store.js";
import type { Query } from "../../../common/query.js";
import type { Ref } from "../../../common/ref.js";
import type { Definition } from "./definition.js";
import type { Effect, Id, Snapshot, View } from "./effect.js";

export class Effects {
    static readonly #empty = new Effects(Store.empty<Id, View>(), 0);

    readonly #entries: Store<Id, View>;
    readonly nextId: Id;

    private constructor(entries: Store<Id, View>, nextId: Id) {
        this.#entries = entries;
        this.nextId = nextId;
    }

    static empty(): Effects {
        return Effects.#empty;
    }

    get size(): number {
        return this.#entries.size;
    }

    get(id: Id): View | undefined;
    get<E extends View>(reference: Ref<E>): E | undefined;
    get<S extends object, H extends object>(
        id: Id,
        definition: Definition<S, H>,
    ): Effect<S, H> | undefined;
    get<E extends View, S extends object, H extends object>(
        identity: Id | Ref<E>,
        definition?: Definition<S, H>,
    ): View | E | Effect<S, H> | undefined {
        const effect = this.#entries.get(typeof identity === "number" ? identity : identity.id);

        if (typeof identity !== "number" && effect?.host.id !== identity.host.id) {
            return undefined;
        }
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
        const effect = this.#entries.get(id);

        return effect === undefined ? undefined : reader(effect as Effect);
    }

    values(): Query<View> {
        return this.#entries.values();
    }

    keys(): Query<Id> {
        return this.#entries.keys();
    }

    add<S extends object, H extends object>(effect: Effect<S, H>): Effects {
        if (effect.id !== this.nextId) {
            throw new RangeError("invalid effect identity");
        }

        const nextId = this.nextId + 1;

        if (!Number.isSafeInteger(nextId)) {
            throw new RangeError("effect identity overflow");
        }

        return new Effects(this.#entries.add(effect.id, effect), nextId);
    }

    replace<S extends object, H extends object>(
        reference: Ref<Effect<S, H>>,
        effect: NoInfer<Effect<S, H>>,
    ): Effects {
        if (reference.id !== effect.id || reference.host.id !== effect.host.id) {
            throw new TypeError("effect identity mismatch");
        }

        const previous = this.#entries.get(reference.id);

        if (previous === undefined) {
            return this;
        }
        if (previous.definition !== effect.definition) {
            throw new TypeError("effect definition cannot change");
        }
        if (previous.host.id !== effect.host.id) {
            throw new TypeError("effect host cannot change");
        }
        if (previous === effect) {
            return this;
        }

        return new Effects(this.#entries.replace(effect.id, effect), this.nextId);
    }

    remove(id: Id): Effects {
        return this.#entries.get(id) === undefined
            ? this
            : new Effects(this.#entries.remove(id), this.nextId);
    }

    toJSON(): { readonly instances: readonly Snapshot[]; readonly nextId: Id } {
        return {
            instances: this.#entries
                .keys()
                .map((id) => this.read(id, (effect): Snapshot => effect)!)
                .toArray(),
            nextId: this.nextId,
        };
    }
}
