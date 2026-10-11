export interface Hook<C, I, O> {
    readonly id: string;
    readonly enabled: (context: C) => boolean;
    readonly invoke: (context: C, input: I) => O;
}

export function set<T extends { readonly id: string }>(
    entries: readonly T[],
    entry: T,
): readonly T[] {
    const index = entries.findIndex((current) => current.id === entry.id);

    if (index < 0) {
        return [...entries, entry];
    }

    return entries[index] === entry
        ? entries
        : [...entries.slice(0, index), entry, ...entries.slice(index + 1)];
}

export function remove<T extends { readonly id: string }>(
    entries: readonly T[],
    id: string,
): readonly T[] {
    return entries.some((entry) => entry.id === id)
        ? entries.filter((entry) => entry.id !== id)
        : entries;
}
