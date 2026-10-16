import type { State as BattleState, Result } from "../../battle/state.js";

export interface Hook<C, T> {
    readonly id: string;
    readonly accepts?: (battle: BattleState, context: C, current: T) => boolean;
    readonly invoke: (battle: BattleState, context: C, current: T) => Result<T>;
}

export interface DispatchOptions<C, T> {
    readonly candidates: (battle: BattleState) => readonly string[];
    readonly find: (battle: BattleState, id: string) => Hook<C, T> | undefined;
    readonly stop?: (battle: BattleState, current: T) => boolean;
}

export function dispatch<C, T>(
    battle: BattleState,
    context: C,
    initial: T,
    options: DispatchOptions<C, T>,
): Result<T> {
    let current = initial;
    const candidates = [...options.candidates(battle)];

    for (const id of candidates) {
        if (options.stop?.(battle, current)) {
            break;
        }

        const hook = options.find(battle, id);

        if (hook === undefined || hook.accepts?.(battle, context, current) === false) {
            continue;
        }

        const result = hook.invoke(battle, context, current);
        battle = result.state;
        current = result.value;
    }

    return { state: battle, value: current };
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
