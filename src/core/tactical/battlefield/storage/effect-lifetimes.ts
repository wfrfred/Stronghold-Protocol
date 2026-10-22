import type { Unit } from "../../unit/unit.js";
import { key, ref as effectRef, type Lifetime, type View } from "../../unit/effect/effect.js";
import type { Ref } from "../../../common/ref.js";

type RefBucket = ReadonlyMap<string, Ref<View>>;

export interface Index {
    readonly dependents: ReadonlyMap<string, RefBucket>;
}

export interface UnitTransition {
    readonly previousUnit: Unit | undefined;
    readonly nextUnit: Unit | undefined;
}

function relationKeys(instance: View | undefined): readonly string[] {
    return instance === undefined || instance.status === "ENDING"
        ? []
        : [
              ...new Set(
                  instance.scopes.flatMap((scope) => (scope.type === "TICK" ? [] : [key(scope)])),
              ),
          ];
}

export function project(units: Iterable<Unit>): Index {
    const dependents = new Map<string, Map<string, Ref<View>>>();

    for (const unit of units) {
        for (const instance of unit.effects.values()) {
            const ref = effectRef(instance);
            const id = key({ type: "EFFECT", ref });

            for (const key of relationKeys(instance)) {
                let bucket = dependents.get(key);

                if (bucket === undefined) {
                    bucket = new Map();
                    dependents.set(key, bucket);
                }

                bucket.set(id, ref);
            }
        }
    }

    return { dependents };
}

export function derive(index: Index, transitions: readonly UnitTransition[]): Index {
    let dependents: Map<string, RefBucket> | undefined;
    const editedBuckets = new Map<string, Map<string, Ref<View>>>();

    const editBucket = (key: string): Map<string, Ref<View>> => {
        let bucket = editedBuckets.get(key);

        if (bucket === undefined) {
            dependents ??= new Map(index.dependents);
            bucket = new Map(index.dependents.get(key));
            editedBuckets.set(key, bucket);
        }

        return bucket;
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

        const ref = effectRef((after ?? before)!);
        const id = key({ type: "EFFECT", ref });
        const beforeKeys = relationKeys(before);
        const afterKeys = relationKeys(after);

        for (const key of beforeKeys) {
            if (!afterKeys.includes(key)) {
                editBucket(key).delete(id);
            }
        }
        for (const key of afterKeys) {
            if (!beforeKeys.includes(key)) {
                editBucket(key).set(id, ref);
            }
        }
    };

    for (const { previousUnit, nextUnit } of transitions) {
        const previousEffects = previousUnit?.effects;
        const nextEffects = nextUnit?.effects;

        if (previousEffects === nextEffects) {
            continue;
        }

        const previousById = new Map(
            previousEffects?.values().map((instance) => [instance.id, instance] as const),
        );

        for (const instance of nextEffects?.values() ?? []) {
            changeRelations(previousById.get(instance.id), instance);
            previousById.delete(instance.id);
        }
        for (const instance of previousById.values()) {
            changeRelations(instance, undefined);
        }
    }

    if (dependents !== undefined) {
        for (const [key, bucket] of editedBuckets) {
            if (bucket.size === 0) {
                dependents.delete(key);
            } else {
                dependents.set(key, bucket);
            }
        }
    }

    return dependents === undefined ? index : { dependents };
}

export function dependents(index: Index, lifetime: Lifetime): readonly Ref<View>[] {
    return [...(index.dependents.get(key(lifetime))?.values() ?? [])].sort(
        (left, right) => left.host.id - right.host.id || left.id - right.id,
    );
}
