import type { BattleState } from "../../battle/execution/context.js";
import type { Unit, UnitId } from "../unit.js";
import { key, type Ref, type Value, type Lifetime } from "./effect.js";

type RefBucket = ReadonlyMap<string, Ref>;

export interface Projection {
    readonly dependents: ReadonlyMap<string, RefBucket>;
}

export interface UnitTransition {
    readonly previousUnit: Unit | undefined;
    readonly nextUnit: Unit | undefined;
}

function instancesOf(unit: Unit | undefined): readonly Value[] | undefined {
    return unit?.effects.instances;
}

function relationKeys(instance: Value | undefined): readonly string[] {
    return instance === undefined || instance.status === "FINISHED"
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

export function project(units: Iterable<Unit>): Projection {
    const dependents = new Map<string, Map<string, Ref>>();

    for (const unit of units) {
        for (const instance of instancesOf(unit) ?? []) {
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

function projectionOf(state: BattleState): Projection {
    return state.battlefield.snapshot("draft").effectLifetimes;
}

export function derive(projection: Projection, transitions: readonly UnitTransition[]): Projection {
    let dependents: Map<string, RefBucket> | undefined;
    const editedBuckets = new Map<string, Map<string, Ref>>();

    const editBucket = (key: string): Map<string, Ref> => {
        let bucket = editedBuckets.get(key);

        if (bucket === undefined) {
            dependents ??= new Map(projection.dependents);
            bucket = new Map(projection.dependents.get(key));
            editedBuckets.set(key, bucket);
        }

        return bucket;
    };
    const changeRelations = (
        unitId: UnitId,
        before: Value | undefined,
        after: Value | undefined,
    ): void => {
        if (
            before === after ||
            (before !== undefined &&
                before.scopes === after?.scopes &&
                (before.status === "FINISHED") === (after.status === "FINISHED"))
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
        const previousInstances = instancesOf(previousUnit);
        const nextInstances = instancesOf(nextUnit);

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

    return dependents === undefined ? projection : { dependents };
}

export function dependents(battle: BattleState, lifetime: Lifetime): readonly Ref[] {
    return [...(projectionOf(battle).dependents.get(key(lifetime))?.values() ?? [])].sort(
        (left, right) => left.unitId - right.unitId || left.effectId - right.effectId,
    );
}
