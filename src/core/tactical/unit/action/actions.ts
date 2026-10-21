import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { Action, Id } from "./action.js";
import type { Definition } from "./definition.js";

type StoredAction = Omit<Action, "definition" | "state"> & {
    readonly definition: Pick<Definition, "id" | "intervalTicks" | "speed">;
    readonly state: object;
};

export class Actions {
    static readonly #empty = new Actions([], 0);

    readonly #entries: readonly StoredAction[];
    readonly nextId: Id;

    private constructor(entries: readonly StoredAction[], nextId: Id) {
        this.#entries = entries;
        this.nextId = nextId;
    }

    static empty(): Actions {
        return Actions.#empty;
    }

    get size(): number {
        return this.#entries.length;
    }

    get(id: Id): StoredAction | undefined;
    get<P extends object, E extends object>(
        id: Id,
        definition: Definition<P, E>,
    ): Action<P, E> | undefined;
    get<P extends object, E extends object>(
        id: Id,
        definition?: Definition<P, E>,
    ): StoredAction | Action<P, E> | undefined {
        const action = this.#entries.find((entry) => entry.id === id);

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
        const action = this.#entries.find((entry) => entry.id === id);

        return action === undefined ? undefined : reader(action as Action);
    }

    values(): readonly StoredAction[] {
        return this.#entries;
    }

    keys(): readonly Id[] {
        return this.#entries.map(({ id }) => id);
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

        return new Actions([...this.#entries, action], nextId);
    }

    replace<P extends object, E extends object>(action: Action<P, E>): Actions {
        const index = this.#entries.findIndex((entry) => entry.id === action.id);

        if (index < 0) {
            return this;
        }

        const previous = this.#entries[index]!;

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

        return new Actions(
            [...this.#entries.slice(0, index), action, ...this.#entries.slice(index + 1)],
            this.nextId,
        );
    }

    remove(id: Id): Actions {
        const index = this.#entries.findIndex((entry) => entry.id === id);

        return index < 0
            ? this
            : new Actions(
                  [...this.#entries.slice(0, index), ...this.#entries.slice(index + 1)],
                  this.nextId,
              );
    }

    toJSON(): { readonly instances: readonly StoredAction[]; readonly nextId: Id } {
        return { instances: this.#entries, nextId: this.nextId };
    }
}
