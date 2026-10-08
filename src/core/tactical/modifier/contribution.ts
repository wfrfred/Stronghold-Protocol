import { assertFiniteNumber, assertNonnegativeSafeInteger } from "../../common/assert.js";
import { createNumericContribution, type NumericContribution } from "./numeric.js";

export interface NumericContributionOwner {
    readonly unitId: number;
    readonly instanceId: number;
}

export interface NumericContributionGroup {
    readonly id: string;
    readonly strength: number;
}

interface NumericContributionBinding {
    readonly id: string;
    readonly sequence: number;
    readonly participating: boolean;
    readonly owner?: NumericContributionOwner;
    readonly group?: NumericContributionGroup;
}

export interface NumericValueContribution extends NumericContributionBinding {
    readonly values: readonly NumericContribution[];
}

export interface NumericProviderContribution extends NumericContributionBinding {
    readonly providerRef: string;
}

export type NumericContributionEntry = NumericValueContribution | NumericProviderContribution;

export interface NumericContributionState {
    readonly entries: readonly NumericContributionEntry[];
}

export type NumericContributionEvaluator = (
    entry: NumericProviderContribution,
) => readonly NumericContribution[];

export type NumericContributionTransition = (
    state: NumericContributionState,
) => NumericContributionState;

const emptyState: NumericContributionState = Object.freeze({ entries: Object.freeze([]) });
const ownedEntries = new WeakSet<NumericContributionEntry>();
const ownedArrays = new WeakSet<readonly NumericContributionEntry[]>([emptyState.entries]);

function ownEntry(
    entry: NumericContributionEntry,
    previous?: NumericContributionEntry,
): NumericContributionEntry {
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
    let owned: NumericContributionEntry;

    if ("values" in entry) {
        if (previous !== undefined && "values" in previous && entry.values === previous.values) {
            owned = Object.freeze({ ...binding, values: previous.values });
        } else {
            const values: NumericContribution[] = [];

            for (let index = 0; index < entry.values.length; index++) {
                if (!Object.hasOwn(entry.values, index)) {
                    throw new TypeError("numeric contribution values must be dense");
                }

                const value = entry.values[index]!;

                values.push(
                    createNumericContribution({
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
        if (entry.providerRef.length === 0) {
            throw new TypeError("numeric contribution provider identity must be nonempty");
        }

        owned = Object.freeze({ ...binding, providerRef: entry.providerRef });
    }

    ownedEntries.add(owned);

    return owned;
}

function publishEntries(entries: NumericContributionEntry[]): NumericContributionState {
    if (entries.length === 0) {
        return emptyState;
    }

    Object.freeze(entries);
    ownedArrays.add(entries);

    return Object.freeze({ entries });
}

function getOwnedEntries(state: NumericContributionState): readonly NumericContributionEntry[] {
    return ownedArrays.has(state.entries)
        ? state.entries
        : createNumericContributionState(state.entries).entries;
}

export function createNumericContributionState(
    entries: readonly NumericContributionEntry[] = [],
): NumericContributionState {
    if (entries.length === 0) {
        return emptyState;
    }
    if (ownedArrays.has(entries)) {
        return Object.freeze({ entries });
    }

    const ids = new Set<string>();
    const owned: NumericContributionEntry[] = [];

    for (let index = 0; index < entries.length; index++) {
        if (!Object.hasOwn(entries, index)) {
            throw new TypeError("numeric contribution entries must be dense");
        }

        const entry = ownEntry(entries[index]!);

        if (ids.has(entry.id)) {
            throw new TypeError(`duplicate numeric contribution ${entry.id}`);
        }

        ids.add(entry.id);
        owned.push(entry);
    }

    return publishEntries(owned);
}

export function copyNumericContributionState(
    state: NumericContributionState,
): NumericContributionState {
    return createNumericContributionState(state.entries);
}

export function registerNumericContribution(
    state: NumericContributionState,
    entry: NumericContributionEntry,
): NumericContributionState {
    const entries = getOwnedEntries(state);
    const owned = ownEntry(entry);

    if (entries.some((current) => current.id === owned.id)) {
        throw new TypeError(`duplicate numeric contribution ${owned.id}`);
    }

    return publishEntries([...entries, owned]);
}

export function updateNumericContribution(
    state: NumericContributionState,
    id: string,
    update: (entry: NumericContributionEntry) => NumericContributionEntry,
): NumericContributionState {
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

    next[index] = ownEntry(updated, current);

    return publishEntries(next);
}

export function setNumericContributionParticipation(
    state: NumericContributionState,
    id: string,
    participating: boolean,
): NumericContributionState {
    return updateNumericContribution(state, id, (entry) =>
        entry.participating === participating ? entry : { ...entry, participating },
    );
}

export function removeNumericContribution(
    state: NumericContributionState,
    id: string,
): NumericContributionState {
    const entries = getOwnedEntries(state).filter((entry) => entry.id !== id);

    return entries.length === state.entries.length ? state : publishEntries(entries);
}

export function removeNumericContributionsOwnedBy(
    state: NumericContributionState,
    owner: NumericContributionOwner,
): NumericContributionState {
    const entries = getOwnedEntries(state).filter(
        (entry) =>
            entry.owner?.unitId !== owner.unitId || entry.owner.instanceId !== owner.instanceId,
    );

    return entries.length === state.entries.length ? state : publishEntries(entries);
}

function compareEntries(left: NumericContributionEntry, right: NumericContributionEntry): number {
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

export function resolveNumericContributions(
    state: NumericContributionState,
    evaluate?: NumericContributionEvaluator,
): readonly NumericContribution[] {
    const candidates = state.entries.filter((entry) => entry.participating).sort(compareEntries);
    const winners = new Map<string, NumericContributionEntry>();

    for (const entry of candidates) {
        if (entry.group === undefined) {
            continue;
        }

        const current = winners.get(entry.group.id);

        if (current === undefined || entry.group.strength > current.group!.strength) {
            winners.set(entry.group.id, entry);
        }
    }

    const values: NumericContribution[] = [];

    for (const entry of candidates) {
        if (entry.group !== undefined && winners.get(entry.group.id) !== entry) {
            continue;
        }
        if ("values" in entry) {
            values.push(...entry.values);
        } else {
            if (evaluate === undefined) {
                throw new TypeError(
                    `numeric contribution provider ${entry.providerRef} requires resources`,
                );
            }

            values.push(...evaluate(entry));
        }
    }

    return values;
}
