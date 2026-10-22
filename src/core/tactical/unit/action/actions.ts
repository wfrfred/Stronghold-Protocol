import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { Store } from "../../../common/collection/store.js";
import type { Query } from "../../../common/query.js";
import type { Ref } from "../../../common/ref.js";
import type { Action, Id, Snapshot, View } from "./action.js";
import type { Definition } from "./definition.js";

export class Actions {
    static readonly #empty = new Actions(Store.empty<Id, View>(), 0);

    readonly #store: Store<Id, View>;
    readonly nextId: Id;

    private constructor(store: Store<Id, View>, nextId: Id) {
        this.#store = store;
        this.nextId = nextId;
    }

    static empty(): Actions {
        return Actions.#empty;
    }

    get size(): number {
        return this.#store.size;
    }

    get(id: Id): View | undefined;
    get<A extends View>(reference: Ref<A>): A | undefined;
    get<P extends object, E extends object>(
        id: Id,
        definition: Definition<P, E>,
    ): Action<P, E> | undefined;
    get<P extends object, E extends object, A extends View>(
        reference: Id | Ref<A>,
        definition?: Definition<P, E>,
    ): View | Action<P, E> | A | undefined {
        const id = typeof reference === "number" ? reference : reference.id;
        const action = this.#store.get(id);

        if (
            action !== undefined &&
            typeof reference !== "number" &&
            action.host.id !== reference.host.id
        ) {
            return undefined;
        }

        if (typeof reference !== "number") {
            return action;
        }

        if (definition === undefined) {
            return action;
        }

        const restored: Action<P, E> | undefined =
            action?.definition === definition ? (action as Action<P, E>) : undefined;

        return restored;
    }

    read<R>(
        id: Id,
        reader: <P extends object, E extends object>(action: Action<P, E>) => R,
    ): R | undefined {
        const action = this.#store.get(id);

        return action === undefined ? undefined : reader(action as Action);
    }

    values(): Query<View> {
        return this.#store.values();
    }

    keys(): Query<Id> {
        return this.#store.keys();
    }

    add<P extends object, E extends object>(action: Action<P, E>): Actions {
        assertNonnegativeSafeInteger(action.id, "action identity");
        assertNonnegativeSafeInteger(action.startedAtTick, "action start tick");

        if (action.id !== this.nextId) {
            throw new RangeError("invalid action identity");
        }

        const nextId = this.nextId + 1;

        if (!Number.isSafeInteger(nextId)) {
            throw new RangeError("action identity overflow");
        }

        return new Actions(this.#store.add(action.id, action), nextId);
    }

    replace<P extends object, E extends object>(
        reference: Ref<Action<P, E>>,
        action: NoInfer<Action<P, E>>,
    ): Actions {
        const previous = this.get(reference);

        if (previous === undefined) {
            return this;
        }
        if (action.id !== reference.id) {
            throw new TypeError("action identity cannot change");
        }
        if (previous.definition !== action.definition) {
            throw new TypeError("action definition cannot change");
        }
        if (previous.host.id !== action.host.id) {
            throw new TypeError("action host cannot change");
        }
        if (previous.startedAtTick !== action.startedAtTick) {
            throw new TypeError("action start tick cannot change");
        }
        if (previous === action) {
            return this;
        }

        return new Actions(this.#store.replace(reference.id, action), this.nextId);
    }

    remove(id: Id): Actions {
        if (this.#store.get(id) === undefined) {
            return this;
        }

        return new Actions(this.#store.remove(id), this.nextId);
    }

    toJSON(): { readonly instances: readonly Snapshot[]; readonly nextId: Id } {
        return {
            instances: this.values()
                .map(({ id }) => this.read<Snapshot>(id, (self) => self)!)
                .toArray(),
            nextId: this.nextId,
        };
    }
}
