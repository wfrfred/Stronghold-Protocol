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

export interface Sampled extends Binding {
    readonly kind: "SAMPLED";
    readonly values: readonly modifier.Value[];
}

export interface Live extends Binding {
    readonly kind: "LIVE";
    readonly evaluator: string;
}

interface Entries {
    readonly SAMPLED: Sampled;
    readonly LIVE: Live;
}

export type Mode = keyof Entries;

export type Entry<M extends Mode = Mode> = M extends Mode ? Entries[M] : never;

export interface State<M extends Mode = Mode> {
    readonly entries: readonly Entry<M>[];
}

export type Evaluate = (entry: Live) => readonly modifier.Value[];

export type Transition<M extends Mode = Mode> = (state: State<M>) => State<M>;

export type SampledTransition = <M extends Mode>(
    state: State<M | "SAMPLED">,
) => State<M | "SAMPLED">;

const emptyState = Object.freeze({ entries: Object.freeze([]) });
const ownedEntries = new WeakSet<Entry>();
const ownedArrays = new WeakSet<readonly Entry[]>([emptyState.entries]);

function ownEntry<M extends Mode>(entry: Entry<M>, previous?: Entry<M>): Entry<M> {
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

    if (entry.kind === "SAMPLED") {
        if (previous?.kind === "SAMPLED" && entry.values === previous.values) {
            owned = Object.freeze({ ...binding, kind: "SAMPLED", values: previous.values });
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

            owned = Object.freeze({ ...binding, kind: "SAMPLED", values: Object.freeze(values) });
        }
    } else {
        if (entry.evaluator.length === 0) {
            throw new TypeError("numeric contribution provider identity must be nonempty");
        }

        owned = Object.freeze({ ...binding, kind: "LIVE", evaluator: entry.evaluator });
    }

    ownedEntries.add(owned);

    return owned as Entry<M>;
}

function publishEntries<M extends Mode>(entries: Entry<M>[]): State<M> {
    if (entries.length === 0) {
        return emptyState;
    }

    Object.freeze(entries);
    ownedArrays.add(entries);

    return Object.freeze({ entries });
}

function getOwnedEntries<M extends Mode>(state: State<M>): readonly Entry<M>[] {
    return ownedArrays.has(state.entries) ? state.entries : create<M>(state.entries).entries;
}

export function create<M extends Mode = Mode>(entries: readonly Entry<M>[] = []): State<M> {
    if (entries.length === 0) {
        return emptyState;
    }
    if (ownedArrays.has(entries)) {
        return Object.freeze({ entries });
    }

    const ids = new Set<string>();
    const owned: Entry<M>[] = [];

    for (let index = 0; index < entries.length; index++) {
        if (!Object.hasOwn(entries, index)) {
            throw new TypeError("numeric contribution entries must be dense");
        }

        const entry = ownEntry<M>(entries[index]!);

        if (ids.has(entry.id)) {
            throw new TypeError(`duplicate numeric contribution ${entry.id}`);
        }

        ids.add(entry.id);
        owned.push(entry);
    }

    return publishEntries<M>(owned);
}

export function copy<M extends Mode>(state: State<M>): State<M> {
    return create<M>(state.entries);
}

export function register<M extends Mode>(state: State<M>, entry: Entry<M>): State<M> {
    const entries = getOwnedEntries(state);
    const owned = ownEntry<M>(entry);

    if (entries.some((current) => current.id === owned.id)) {
        throw new TypeError(`duplicate numeric contribution ${owned.id}`);
    }

    return publishEntries<M>([...entries, owned]);
}

export function update<M extends Mode>(
    state: State<M>,
    id: string,
    update: (entry: Entry<M>) => Entry<M>,
): State<M> {
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

    next[index] = ownEntry<M>(updated, current);

    return publishEntries<M>(next);
}

export function setParticipation<M extends Mode>(
    state: State<M>,
    id: string,
    participating: boolean,
): State<M> {
    return update<M>(state, id, (entry) =>
        entry.participating === participating ? entry : { ...entry, participating },
    );
}

export function remove<M extends Mode>(state: State<M>, id: string): State<M> {
    const entries = getOwnedEntries(state).filter((entry) => entry.id !== id);

    return entries.length === state.entries.length ? state : publishEntries<M>(entries);
}

export function removeOwnedBy<M extends Mode>(state: State<M>, owner: Owner): State<M> {
    const entries = getOwnedEntries(state).filter(
        (entry) =>
            entry.owner?.unitId !== owner.unitId || entry.owner.instanceId !== owner.instanceId,
    );

    return entries.length === state.entries.length ? state : publishEntries<M>(entries);
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

export function resolve<M extends Mode>(
    state: State<M>,
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
        if (entry.kind === "SAMPLED") {
            values.push(...entry.values);
        } else {
            if (evaluate === undefined) {
                throw new TypeError(`live contribution ${entry.evaluator} requires resources`);
            }

            values.push(...evaluate(entry));
        }
    }

    return values;
}
