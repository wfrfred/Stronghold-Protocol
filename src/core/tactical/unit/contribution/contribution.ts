import type { Value } from "./value.js";

export type Input<C> = readonly Value[] | ((context: C) => readonly Value[]);

export interface Group {
    readonly id: string;
    readonly priority: number;
}

export interface Contribution<V = readonly Value[]> {
    readonly id: string;
    readonly value: V;
    readonly group?: Group;
}

export function set<V>(
    entries: readonly Contribution<V>[],
    contribution: Contribution<V>,
): readonly Contribution<V>[] {
    if (contribution.id.length === 0) {
        throw new TypeError("contribution identity must be nonempty");
    }
    if (
        contribution.group !== undefined &&
        (contribution.group.id.length === 0 || !Number.isFinite(contribution.group.priority))
    ) {
        throw new TypeError("contribution group requires an identity and finite priority");
    }

    const index = entries.findIndex(({ id }) => id === contribution.id);

    if (index === -1) {
        return [...entries, contribution];
    }
    if (entries[index] === contribution) {
        return entries;
    }

    const updated = [...entries];
    updated[index] = contribution;

    return updated;
}

export function remove<V>(
    entries: readonly Contribution<V>[],
    id: string,
): readonly Contribution<V>[] {
    const updated = entries.filter((entry) => entry.id !== id);

    return updated.length === entries.length ? entries : updated;
}

export function evaluate<C>(input: Input<C>, context: C): readonly Value[] {
    return typeof input === "function" ? input(context) : input;
}

export function resolve(entries: readonly Contribution[]): readonly Value[];
export function resolve<V>(
    entries: readonly Contribution<V>[],
    read: (value: V) => readonly Value[],
): readonly Value[];
export function resolve<V>(
    entries: readonly Contribution<V>[],
    read?: (value: V) => readonly Value[],
): readonly Value[] {
    const ordered = [...entries].sort((a, b) => {
        if (a.id === b.id) {
            return 0;
        }

        return a.id < b.id ? -1 : 1;
    });
    const winners = new Map<string, Contribution<V>>();

    for (const entry of ordered) {
        if (entry.group === undefined) {
            continue;
        }

        const current = winners.get(entry.group.id);

        if (current === undefined || entry.group.priority > current.group!.priority) {
            winners.set(entry.group.id, entry);
        }
    }

    const values: Value[] = [];

    for (const entry of ordered) {
        if (entry.group === undefined || winners.get(entry.group.id) === entry) {
            values.push(
                ...(read === undefined ? (entry.value as readonly Value[]) : read(entry.value)),
            );
        }
    }

    return values;
}
