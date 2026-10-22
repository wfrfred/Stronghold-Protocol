import { assertNonnegativeNumber } from "../../../common/assert.js";
import { Store } from "../../../common/collection/store.js";
import type { Query } from "../../../common/query.js";
import type { Definition, Id, View } from "./definition.js";

export class Definitions {
    static readonly #empty = new Definitions(Store.empty<Id, View>());

    readonly #store: Store<Id, View>;

    private constructor(store: Store<Id, View>) {
        this.#store = store;
    }

    static empty(): Definitions {
        return Definitions.#empty;
    }

    get size(): number {
        return this.#store.size;
    }

    get(id: Id): View | undefined;
    get<P extends object, E extends object>(
        id: Id,
        definition: Definition<P, E>,
    ): Definition<P, E> | undefined;
    get<P extends object, E extends object>(
        id: Id,
        definition?: Definition<P, E>,
    ): View | Definition<P, E> | undefined {
        const stored = this.#store.get(id);

        if (definition === undefined) {
            return stored;
        }

        return stored === definition ? definition : undefined;
    }

    read<R>(
        id: Id,
        reader: <P extends object, E extends object>(definition: Definition<P, E>) => R,
    ): R | undefined {
        const definition = this.#store.get(id);

        return definition === undefined ? undefined : reader(definition as Definition);
    }

    values(): Query<View> {
        return this.#store.values();
    }

    keys(): Query<Id> {
        return this.#store.keys();
    }

    add<P extends object, E extends object>(definition: Definition<P, E>): Definitions {
        if (definition.id.length === 0) {
            throw new TypeError("action definition identity must be nonempty");
        }
        if (this.#store.get(definition.id) !== undefined) {
            throw new RangeError(`duplicate action definition: ${definition.id}`);
        }

        assertNonnegativeNumber(definition.intervalTicks, "action base interval");
        assertNonnegativeNumber(definition.speed, "action base speed");

        return new Definitions(this.#store.add(definition.id, definition));
    }
}
