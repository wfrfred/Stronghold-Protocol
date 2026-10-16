import { assertNonnegativeNumber } from "../../../common/assert.js";
import type { Definition, Id } from "./definition.js";

type StoredDefinition = Pick<Definition, "id" | "intervalTicks" | "speed">;

export class Definitions {
    static readonly #empty = new Definitions([]);

    readonly #entries: readonly StoredDefinition[];

    private constructor(entries: readonly StoredDefinition[]) {
        this.#entries = entries;
    }

    static empty(): Definitions {
        return Definitions.#empty;
    }

    get size(): number {
        return this.#entries.length;
    }

    get(id: Id): StoredDefinition | undefined;
    get<P extends object, E extends object>(
        id: Id,
        definition: Definition<P, E>,
    ): Definition<P, E> | undefined;
    get<P extends object, E extends object>(
        id: Id,
        definition?: Definition<P, E>,
    ): StoredDefinition | Definition<P, E> | undefined {
        const stored = this.#entries.find((entry) => entry.id === id);

        if (definition === undefined) {
            return stored;
        }

        return stored === definition ? definition : undefined;
    }

    read<R>(
        id: Id,
        reader: <P extends object, E extends object>(definition: Definition<P, E>) => R,
    ): R | undefined {
        const definition = this.#entries.find((entry) => entry.id === id);

        return definition === undefined ? undefined : reader(definition as Definition);
    }

    values(): readonly StoredDefinition[] {
        return this.#entries;
    }

    keys(): readonly Id[] {
        return this.#entries.map(({ id }) => id);
    }

    add<P extends object, E extends object>(definition: Definition<P, E>): Definitions {
        if (definition.id.length === 0) {
            throw new TypeError("action definition identity must be nonempty");
        }
        if (this.#entries.some(({ id }) => id === definition.id)) {
            throw new RangeError(`duplicate action definition: ${definition.id}`);
        }

        assertNonnegativeNumber(definition.intervalTicks, "action base interval");
        assertNonnegativeNumber(definition.speed, "action base speed");

        return new Definitions([...this.#entries, definition]);
    }
}
