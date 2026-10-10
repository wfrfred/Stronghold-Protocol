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

const emptyState: State<never> = { entries: [] };

export function empty<M extends Mode = Mode>(): State<M> {
    return emptyState;
}

function validateEntry(entry: Entry): void {
    if (entry.id.length === 0) {
        throw new TypeError("numeric contribution identity must be nonempty");
    }

    assertNonnegativeSafeInteger(entry.sequence, "numeric contribution sequence");

    if (entry.owner !== undefined) {
        assertNonnegativeSafeInteger(entry.owner.unitId, "numeric contribution owner unit id");
        assertNonnegativeSafeInteger(
            entry.owner.instanceId,
            "numeric contribution owner instance id",
        );
    }
    if (entry.group !== undefined) {
        if (entry.group.id.length === 0) {
            throw new TypeError("numeric contribution group must have an identity");
        }

        assertFiniteNumber(entry.group.strength, "numeric contribution group strength", TypeError);
    }
    if (entry.kind === "LIVE" && entry.evaluator.length === 0) {
        throw new TypeError("numeric contribution evaluator identity must be nonempty");
    }
}

export function register<M extends Mode>(state: State<M>, entry: Entry<M>): State<M> {
    validateEntry(entry);

    if (state.entries.some((current) => current.id === entry.id)) {
        throw new TypeError(`duplicate numeric contribution ${entry.id}`);
    }

    return { entries: [...state.entries, entry] };
}

export function update<M extends Mode>(
    state: State<M>,
    id: string,
    update: (entry: Entry<M>) => Entry<M>,
): State<M> {
    const index = state.entries.findIndex((entry) => entry.id === id);

    if (index === -1) {
        return state;
    }

    const current = state.entries[index]!;
    const updated = update(current);

    if (updated === current) {
        return state;
    }
    if (updated.id !== id) {
        throw new TypeError("numeric contribution update cannot replace its identity");
    }

    validateEntry(updated);
    const entries = [...state.entries];

    entries[index] = updated;

    return { entries };
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
    const entries = state.entries.filter((entry) => entry.id !== id);

    return entries.length === state.entries.length ? state : { entries };
}

export function removeOwnedBy<M extends Mode>(state: State<M>, owner: Owner): State<M> {
    const entries = state.entries.filter(
        (entry) =>
            entry.owner?.unitId !== owner.unitId || entry.owner.instanceId !== owner.instanceId,
    );

    return entries.length === state.entries.length ? state : { entries };
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
