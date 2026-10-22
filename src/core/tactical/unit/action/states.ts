import { Store } from "../../../common/collection/store.js";
import type { Query } from "../../../common/query.js";
import type { Definition, Id } from "./definition.js";
import type { Snapshot, State, View } from "./state.js";

export class States {
    static readonly #empty = new States(Store.empty<Id, View>());

    readonly #store: Store<Id, View>;

    private constructor(store: Store<Id, View>) {
        this.#store = store;
    }

    static empty(): States {
        return States.#empty;
    }

    get size(): number {
        return this.#store.size;
    }

    get(id: Id): View | undefined;
    get<P extends object, E extends object>(
        id: Id,
        definition: Definition<P, E>,
    ): State<P, E> | undefined;
    get<P extends object, E extends object>(
        id: Id,
        definition?: Definition<P, E>,
    ): View | State<P, E> | undefined {
        const state = this.#store.get(id);

        if (definition === undefined) {
            return state;
        }

        const restored: State<P, E> | undefined =
            state?.definition === definition ? (state as State<P, E>) : undefined;

        return restored;
    }

    read<R>(
        id: Id,
        reader: <P extends object, E extends object>(self: State<P, E>) => R,
    ): R | undefined {
        const state = this.#store.get(id);

        return state === undefined ? undefined : reader(state as State);
    }

    keys(): Query<Id> {
        return this.#store.keys();
    }

    values(): Query<View> {
        return this.#store.values();
    }

    add<P extends object, E extends object>(self: State<P, E>): States {
        return new States(this.#store.add(self.definition.id, self));
    }

    replace<P extends object, E extends object>(
        definition: Definition<P, E>,
        next: NoInfer<State<P, E>>,
    ): States {
        const current = this.#store.get(definition.id);

        if (current === undefined) {
            return this;
        }
        if (current.definition !== definition || next.definition !== definition) {
            throw new TypeError("action definition cannot change");
        }

        const store = this.#store.replace(definition.id, next);

        return store === this.#store ? this : new States(store);
    }

    toJSON(): readonly Snapshot[] {
        return this.values()
            .map(({ definition }) => this.read<Snapshot>(definition.id, (self) => self)!)
            .toArray();
    }
}
