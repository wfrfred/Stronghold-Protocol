import type { CombatWork } from "../../../battle/execution/work.js";
import type { Unit, UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import {
    lifetimeKey,
    refKey,
    type EffectRef,
    type EffectInstanceValue,
    type LifetimeRef,
} from "./instance.js";

type RefBucket = ReadonlyMap<string, EffectRef>;

export interface EffectLifetimeProjection {
    readonly dependents: ReadonlyMap<string, RefBucket>;
    readonly timed: ReadonlyMap<string, EffectRef>;
}

export interface EffectUnitTransition {
    readonly previousUnit: Unit | undefined;
    readonly nextUnit: Unit | undefined;
}

const projections = new WeakMap<
    CombatWork["unitUpdates"],
    WeakMap<CombatWork["removals"], EffectLifetimeProjection>
>();

function instancesOf(unit: Unit | undefined): readonly EffectInstanceValue[] | undefined {
    return unit !== undefined && hasEffects(unit) ? unit.effects.instances : undefined;
}

function relationKeys(instance: EffectInstanceValue | undefined): readonly string[] {
    return instance === undefined || instance.finished
        ? []
        : [
              ...new Set(
                  instance.scopes.flatMap((scope) =>
                      scope.type === "TICK" ? [] : [lifetimeKey(scope)],
                  ),
              ),
          ];
}

function isTimed(instance: EffectInstanceValue | undefined): boolean {
    return (
        instance !== undefined &&
        !instance.finished &&
        instance.scopes.some((scope) => scope.type === "TICK")
    );
}

function effectRef(unitId: UnitId, effectId: number): EffectRef {
    return Object.freeze({ type: "EFFECT", unitId, effectId });
}

function storedProjection(work: CombatWork): EffectLifetimeProjection | undefined {
    return projections.get(work.unitUpdates)?.get(work.removals);
}

function storeProjection(work: CombatWork, projection: EffectLifetimeProjection): void {
    let byRemovals = projections.get(work.unitUpdates);

    if (byRemovals === undefined) {
        byRemovals = new WeakMap();
        projections.set(work.unitUpdates, byRemovals);
    }

    byRemovals.set(work.removals, projection);
}

/** Captures the immutable projection belonging to this Work's Battlefield baseline. */
export function captureEffectLifetimeProjection(work: CombatWork): void {
    if ("effectLifetimes" in work.battlefield && work.battlefield.effectLifetimes !== undefined) {
        storeProjection(work, work.battlefield.effectLifetimes as EffectLifetimeProjection);
    }
}

export function projectEffectLifetimes(units: Iterable<Unit>): EffectLifetimeProjection {
    const dependents = new Map<string, Map<string, EffectRef>>();
    const timed = new Map<string, EffectRef>();

    for (const unit of units) {
        for (const instance of instancesOf(unit) ?? []) {
            const ref = effectRef(unit.id, instance.id);
            const id = refKey(ref);

            for (const key of relationKeys(instance)) {
                let bucket = dependents.get(key);

                if (bucket === undefined) {
                    bucket = new Map();
                    dependents.set(key, bucket);
                }

                bucket.set(id, ref);
            }
            if (isTimed(instance)) {
                timed.set(id, ref);
            }
        }
    }

    return { dependents, timed };
}

function projectionOf(work: CombatWork): EffectLifetimeProjection {
    const stored = storedProjection(work);

    if (stored !== undefined) {
        return stored;
    }

    const ids = new Set([...work.battlefield.unitIds, ...work.unitUpdates.keys()]);

    const units = function* () {
        for (const unitId of ids) {
            if (!work.removals.has(unitId)) {
                const unit = work.unitUpdates.get(unitId) ?? work.battlefield.getUnit(unitId);

                if (unit !== undefined) {
                    yield unit;
                }
            }
        }
    };

    const projection = projectEffectLifetimes(units());
    storeProjection(work, projection);

    return projection;
}

export function deriveEffectLifetimes(
    projection: EffectLifetimeProjection,
    transitions: readonly EffectUnitTransition[],
): EffectLifetimeProjection {
    let dependents: Map<string, RefBucket> | undefined;
    let timed: Map<string, EffectRef> | undefined;
    const editedBuckets = new Map<string, Map<string, EffectRef>>();

    const editBucket = (key: string): Map<string, EffectRef> => {
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
        before: EffectInstanceValue | undefined,
        after: EffectInstanceValue | undefined,
    ): void => {
        if (
            before === after ||
            (before !== undefined &&
                before.scopes === after?.scopes &&
                before.finished === after.finished)
        ) {
            return;
        }

        const ref = effectRef(unitId, (after ?? before)!.id);
        const id = refKey(ref);
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
        if (isTimed(before) !== isTimed(after)) {
            timed ??= new Map(projection.timed);

            if (isTimed(after)) {
                timed.set(id, ref);
            } else {
                timed.delete(id);
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

    return dependents === undefined && timed === undefined
        ? projection
        : { dependents: dependents ?? projection.dependents, timed: timed ?? projection.timed };
}

export function deriveEffectLifetimeProjection(
    previous: CombatWork,
    next: CombatWork,
    transitions: readonly EffectUnitTransition[],
): void {
    const projection = storedProjection(previous);

    if (projection !== undefined) {
        storeProjection(next, deriveEffectLifetimes(projection, transitions));
    }
}

function sortedRefs(refs: Iterable<EffectRef>): readonly EffectRef[] {
    return Object.freeze(
        [...refs].sort(
            (left, right) => left.unitId - right.unitId || left.effectId - right.effectId,
        ),
    );
}

export function effectDependents(work: CombatWork, lifetime: LifetimeRef): readonly EffectRef[] {
    return sortedRefs(projectionOf(work).dependents.get(lifetimeKey(lifetime))?.values() ?? []);
}

export function effectTickCandidates(work: CombatWork): readonly EffectRef[] {
    return sortedRefs(projectionOf(work).timed.values());
}
