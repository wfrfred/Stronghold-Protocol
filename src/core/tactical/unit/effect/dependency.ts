import type { Ref } from "../../../common/ref.js";
import type { Unit } from "../unit.js";
import { ref as effectRef, type Lifetime, type View } from "./effect.js";

export type Bucket = readonly Ref<View>[];

type Hosted = ReadonlyMap<number, ReadonlyMap<number, Bucket>>;

export interface State {
    readonly unit: ReadonlyMap<number, Bucket>;
    readonly action: Hosted;
    readonly skill: Hosted;
    readonly elementalBurst: Hosted;
    readonly effect: Hosted;
}

export interface UnitTransition {
    readonly previousUnit: Unit | undefined;
    readonly nextUnit: Unit | undefined;
}

const branches = {
    ACTION: "action",
    SKILL: "skill",
    ELEMENTAL_BURST: "elementalBurst",
    EFFECT: "effect",
} as const;

type Branch = (typeof branches)[keyof typeof branches];

const emptyBucket: Bucket = [];

export function empty(): State {
    return {
        unit: new Map(),
        action: new Map(),
        skill: new Map(),
        elementalBurst: new Map(),
        effect: new Map(),
    };
}

function sameLifetime(left: Lifetime, right: Lifetime): boolean {
    if (left.type !== right.type) {
        return false;
    }
    if (left.type === "UNIT") {
        return right.type === "UNIT" && left.ref.id === right.ref.id;
    }

    return (
        right.type !== "UNIT" &&
        left.ref.host.id === right.ref.host.id &&
        left.ref.id === right.ref.id
    );
}

function lifetimes(instance: View | undefined): readonly Lifetime[] {
    const result: Lifetime[] = [];

    if (instance !== undefined && instance.status !== "ENDING") {
        for (const scope of instance.scopes) {
            if (scope.type !== "TICK" && !result.some((entry) => sameLifetime(entry, scope))) {
                result.push(scope);
            }
        }
    }

    return result;
}

function compare(left: Ref<View>, right: Ref<View>): number {
    return left.host.id - right.host.id || left.id - right.id;
}

function add(bucket: Bucket, reference: Ref<View>): Bucket {
    const index = bucket.findIndex((entry) => compare(entry, reference) >= 0);

    if (index < 0) {
        return [...bucket, reference];
    }

    return compare(bucket[index]!, reference) === 0
        ? bucket
        : [...bucket.slice(0, index), reference, ...bucket.slice(index)];
}

function remove(bucket: Bucket, reference: Ref<View>): Bucket {
    const index = bucket.findIndex((entry) => compare(entry, reference) === 0);

    return index < 0 ? bucket : [...bucket.slice(0, index), ...bucket.slice(index + 1)];
}

export function project(units: Iterable<Unit>): State {
    return derive(
        empty(),
        Array.from(units, (nextUnit) => ({ previousUnit: undefined, nextUnit })),
    );
}

export function derive(index: State, transitions: readonly UnitTransition[]): State {
    let unit: Map<number, Bucket> | undefined;
    const hosted: Partial<Record<Branch, Map<number, ReadonlyMap<number, Bucket>>>> = {};
    const edited: Partial<Record<Branch, Map<number, Map<number, Bucket>>>> = {};

    const change = (lifetime: Lifetime, reference: Ref<View>, inserting: boolean): void => {
        const update = inserting ? add : remove;

        if (lifetime.type === "UNIT") {
            const before = (unit ?? index.unit).get(lifetime.ref.id) ?? emptyBucket;
            const after = update(before, reference);

            if (after !== before) {
                unit ??= new Map(index.unit);

                if (after.length === 0) {
                    unit.delete(lifetime.ref.id);
                } else {
                    unit.set(lifetime.ref.id, after);
                }
            }

            return;
        }

        const branch = branches[lifetime.type];
        const host = lifetime.ref.host.id;
        const current = (hosted[branch] ?? index[branch]).get(host);
        const before = current?.get(lifetime.ref.id) ?? emptyBucket;
        const after = update(before, reference);

        if (after === before) {
            return;
        }

        const hosts = (hosted[branch] ??= new Map(index[branch]));
        const entries = (edited[branch] ??= new Map());
        let instances = entries.get(host);

        if (instances === undefined) {
            instances = new Map(current);
            entries.set(host, instances);
        }
        if (after.length === 0) {
            instances.delete(lifetime.ref.id);
        } else {
            instances.set(lifetime.ref.id, after);
        }
        if (instances.size === 0) {
            hosts.delete(host);
        } else {
            hosts.set(host, instances);
        }
    };
    const changeRelations = (before: View | undefined, after: View | undefined): void => {
        if (
            before === after ||
            (before !== undefined &&
                before.scopes === after?.scopes &&
                (before.status === "ENDING") === (after.status === "ENDING"))
        ) {
            return;
        }

        const reference = effectRef((after ?? before)!);
        const previous = lifetimes(before);
        const next = lifetimes(after);

        for (const lifetime of previous) {
            if (!next.some((entry) => sameLifetime(entry, lifetime))) {
                change(lifetime, reference, false);
            }
        }
        for (const lifetime of next) {
            if (!previous.some((entry) => sameLifetime(entry, lifetime))) {
                change(lifetime, reference, true);
            }
        }
    };

    for (const { previousUnit, nextUnit } of transitions) {
        const previousEffects = previousUnit?.effects;
        const nextEffects = nextUnit?.effects;

        if (previousEffects === nextEffects) {
            continue;
        }

        const previous = new Map(
            previousEffects?.values().map((instance) => [instance.id, instance] as const),
        );

        for (const instance of nextEffects?.values() ?? []) {
            changeRelations(previous.get(instance.id), instance);
            previous.delete(instance.id);
        }
        for (const instance of previous.values()) {
            changeRelations(instance, undefined);
        }
    }

    return unit === undefined && Object.keys(hosted).length === 0
        ? index
        : { ...index, ...(unit === undefined ? {} : { unit }), ...hosted };
}

export function dependents(index: State, lifetime: Lifetime): Bucket {
    return lifetime.type === "UNIT"
        ? (index.unit.get(lifetime.ref.id) ?? emptyBucket)
        : (index[branches[lifetime.type]].get(lifetime.ref.host.id)?.get(lifetime.ref.id) ??
              emptyBucket);
}
