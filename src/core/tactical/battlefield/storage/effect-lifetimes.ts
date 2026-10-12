import type { Unit, UnitId } from "../../unit/unit.js";
import { key, type Ref, type Lifetime } from "../../unit/effect/effect.js";

type RefBucket = ReadonlyMap<string, Ref>;

type StoredEffect = ReturnType<Unit["effects"]["values"]>[number];

export interface Index {
    readonly dependents: ReadonlyMap<string, RefBucket>;
}

export interface UnitTransition {
    readonly previousUnit: Unit | undefined;
    readonly nextUnit: Unit | undefined;
}

function relationKeys(instance: StoredEffect | undefined): readonly string[] {
    return instance === undefined || instance.status === "ENDING"
        ? []
        : [
              ...new Set(
                  instance.scopes.flatMap((scope) => (scope.type === "TICK" ? [] : [key(scope)])),
              ),
          ];
}

function effectRef(unitId: UnitId, effectId: number): Ref {
    return { type: "EFFECT", unitId, effectId };
}

export function project(units: Iterable<Unit>): Index {
    const dependents = new Map<string, Map<string, Ref>>();

    for (const unit of units) {
        for (const instance of unit.effects.values()) {
            const ref = effectRef(unit.id, instance.id);
            const id = key(ref);

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
    const editedBuckets = new Map<string, Map<string, Ref>>();

    const editBucket = (key: string): Map<string, Ref> => {
        let bucket = editedBuckets.get(key);

        if (bucket === undefined) {
            dependents ??= new Map(index.dependents);
            bucket = new Map(index.dependents.get(key));
            editedBuckets.set(key, bucket);
        }

        return bucket;
    };
    const changeRelations = (
        unitId: UnitId,
        before: StoredEffect | undefined,
        after: StoredEffect | undefined,
    ): void => {
        if (
            before === after ||
            (before !== undefined &&
                before.scopes === after?.scopes &&
                (before.status === "ENDING") === (after.status === "ENDING"))
        ) {
            return;
        }

        const ref = effectRef(unitId, (after ?? before)!.id);
        const id = key(ref);
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
        const previousInstances = previousUnit?.effects.values();
        const nextInstances = nextUnit?.effects.values();

        if (previousInstances === nextInstances) {
            continue;
        }

        const unitId = (nextUnit ?? previousUnit)!.id;
        const previousById = new Map(previousInstances?.map((instance) => [instance.id, instance]));

        for (const instance of nextInstances ?? []) {
            changeRelations(unitId, previousById.get(instance.id), instance);
            previousById.delete(instance.id);
        }
        for (const instance of previousById.values()) {
            changeRelations(unitId, instance, undefined);
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

export function dependents(index: Index, lifetime: Lifetime): readonly Ref[] {
    return [...(index.dependents.get(key(lifetime))?.values() ?? [])].sort(
        (left, right) => left.unitId - right.unitId || left.effectId - right.effectId,
    );
}
