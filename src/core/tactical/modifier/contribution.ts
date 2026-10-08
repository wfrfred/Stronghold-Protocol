import { assertFiniteNumber, assertNonnegativeSafeInteger } from "../../common/assert.js";
import * as modifier from "./value.js";

export interface Owner {
    readonly unitId: number;
    readonly instanceId: number;
}

export interface Group {
    readonly id: string;
    readonly strength: number;
}

interface Binding {
    readonly id: string;
    readonly sequence: number;
    readonly participating: boolean;
    readonly owner?: Owner;
    readonly group?: Group;
}

export interface Stored extends Binding {
    readonly values: readonly modifier.Value[];
}

export interface Computed extends Binding {
    readonly computeRef: string;
}

export type Entry = Stored | Computed;

interface Entries {
    readonly stored: Stored;
    readonly all: Entry;
}

export type Kind = keyof Entries;

export interface State<K extends Kind = "all"> {
    readonly entries: readonly Entries[K][];
}

export type Evaluate = (entry: Computed) => readonly modifier.Value[];

export type Transition<K extends Kind = "all"> = (state: State<K>) => State<K>;

export type ProjectionTransition = <K extends Kind>(state: State<K>) => State<K>;

const emptyState = Object.freeze({ entries: Object.freeze([]) });
const ownedEntries = new WeakSet<Entry>();
const ownedArrays = new WeakSet<readonly Entry[]>([emptyState.entries]);

function ownEntry<K extends Kind>(entry: Entries[K], previous?: Entries[K]): Entries[K] {
    if (ownedEntries.has(entry)) {
        return entry;
    }
    if (previous === undefined && entry.id.length === 0) {
        throw new TypeError("numeric contribution identity must be nonempty");
    }
    if (entry.sequence !== previous?.sequence) {
        assertNonnegativeSafeInteger(entry.sequence, "numeric contribution sequence");
    }

    let owner = entry.owner;
    let group = entry.group;

    if (owner !== undefined && owner !== previous?.owner) {
        assertNonnegativeSafeInteger(owner.unitId, "numeric contribution owner unit id");
        assertNonnegativeSafeInteger(owner.instanceId, "numeric contribution owner instance id");
        owner = Object.freeze({ unitId: owner.unitId, instanceId: owner.instanceId });
    }
    if (group !== undefined && group !== previous?.group) {
        if (group.id.length === 0) {
            throw new TypeError("numeric contribution group must have an identity");
        }

        assertFiniteNumber(group.strength, "numeric contribution group strength", TypeError);
        group = Object.freeze({ id: group.id, strength: group.strength });
    }

    const binding = {
        id: entry.id,
        sequence: entry.sequence,
        participating: entry.participating,
        ...(owner === undefined ? {} : { owner }),
        ...(group === undefined ? {} : { group }),
    };
    let owned: Entry;

    if ("values" in entry) {
        if (previous !== undefined && "values" in previous && entry.values === previous.values) {
            owned = Object.freeze({ ...binding, values: previous.values });
        } else {
            const values: modifier.Value[] = [];

            for (let index = 0; index < entry.values.length; index++) {
                if (!Object.hasOwn(entry.values, index)) {
                    throw new TypeError("numeric contribution values must be dense");
                }

                const value = entry.values[index]!;

                values.push(
                    modifier.create({
                        addition: value.addition,
                        multiplier: value.multiplier,
                        finalAddition: value.finalAddition,
                        finalScaler: value.finalScaler,
                    }),
                );
            }

            owned = Object.freeze({ ...binding, values: Object.freeze(values) });
        }
    } else {
        if (entry.computeRef.length === 0) {
            throw new TypeError("numeric contribution provider identity must be nonempty");
        }

        owned = Object.freeze({ ...binding, computeRef: entry.computeRef });
    }

    ownedEntries.add(owned);

    return owned as Entries[K];
}

function publishEntries<K extends Kind>(entries: Entries[K][]): State<K> {
    if (entries.length === 0) {
        return emptyState;
    }

    Object.freeze(entries);
    ownedArrays.add(entries);

    return Object.freeze({ entries });
}

function getOwnedEntries<K extends Kind>(state: State<K>): readonly Entries[K][] {
    return ownedArrays.has(state.entries) ? state.entries : create<K>(state.entries).entries;
}

export function create<K extends Kind = "all">(entries: readonly Entries[K][] = []): State<K> {
    if (entries.length === 0) {
        return emptyState;
    }
    if (ownedArrays.has(entries)) {
        return Object.freeze({ entries });
    }

    const ids = new Set<string>();
    const owned: Entries[K][] = [];

    for (let index = 0; index < entries.length; index++) {
        if (!Object.hasOwn(entries, index)) {
            throw new TypeError("numeric contribution entries must be dense");
        }

        const entry = ownEntry<K>(entries[index]!);

        if (ids.has(entry.id)) {
            throw new TypeError(`duplicate numeric contribution ${entry.id}`);
        }

        ids.add(entry.id);
        owned.push(entry);
    }

    return publishEntries<K>(owned);
}

export function copy<K extends Kind>(state: State<K>): State<K> {
    return create<K>(state.entries);
}

export function register<K extends Kind>(state: State<K>, entry: Entries[K]): State<K> {
    const entries = getOwnedEntries(state);
    const owned = ownEntry<K>(entry);

    if (entries.some((current) => current.id === owned.id)) {
        throw new TypeError(`duplicate numeric contribution ${owned.id}`);
    }

    return publishEntries<K>([...entries, owned]);
}

export function update<K extends Kind>(
    state: State<K>,
    id: string,
    update: (entry: Entries[K]) => Entries[K],
): State<K> {
    const entries = getOwnedEntries(state);
    const index = entries.findIndex((entry) => entry.id === id);

    if (index === -1) {
        return state;
    }

    const current = entries[index]!;
    const updated = update(current);

    if (updated.id !== id) {
        throw new TypeError("numeric contribution update cannot replace its identity");
    }
    if (updated === current) {
        return state;
    }

    const next = [...entries];

    next[index] = ownEntry<K>(updated, current);

    return publishEntries<K>(next);
}

export function setParticipation<K extends Kind>(
    state: State<K>,
    id: string,
    participating: boolean,
): State<K> {
    return update<K>(state, id, (entry) =>
        entry.participating === participating ? entry : { ...entry, participating },
    );
}

export function remove<K extends Kind>(state: State<K>, id: string): State<K> {
    const entries = getOwnedEntries(state).filter((entry) => entry.id !== id);

    return entries.length === state.entries.length ? state : publishEntries<K>(entries);
}

export function removeOwnedBy<K extends Kind>(state: State<K>, owner: Owner): State<K> {
    const entries = getOwnedEntries(state).filter(
        (entry) =>
            entry.owner?.unitId !== owner.unitId || entry.owner.instanceId !== owner.instanceId,
    );

    return entries.length === state.entries.length ? state : publishEntries<K>(entries);
}

function compareEntries(left: Entry, right: Entry): number {
    const order =
        left.sequence - right.sequence ||
        (left.owner?.instanceId ?? 0) - (right.owner?.instanceId ?? 0) ||
        (left.owner?.unitId ?? 0) - (right.owner?.unitId ?? 0);

    if (order !== 0) {
        return order;
    }

    if (left.id === right.id) {
        return 0;
    }

    return left.id < right.id ? -1 : 1;
}

export function resolve<K extends Kind>(
    state: State<K>,
    evaluate?: Evaluate,
): readonly modifier.Value[] {
    const candidates = state.entries.filter((entry) => entry.participating).sort(compareEntries);
    const winners = new Map<string, Entry>();

    for (const entry of candidates) {
        if (entry.group === undefined) {
            continue;
        }

        const current = winners.get(entry.group.id);

        if (current === undefined || entry.group.strength > current.group!.strength) {
            winners.set(entry.group.id, entry);
        }
    }

    const values: modifier.Value[] = [];

    for (const entry of candidates) {
        if (entry.group !== undefined && winners.get(entry.group.id) !== entry) {
            continue;
        }
        if ("values" in entry) {
            values.push(...entry.values);
        } else {
            if (evaluate === undefined) {
                throw new TypeError(`computed contribution ${entry.computeRef} requires resources`);
            }

            values.push(...evaluate(entry));
        }
    }

    return values;
}
