import type { CombatWork } from "../../../battle/execution/work.js";
import type { Unit, UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import type { EffectAddress, EffectInstanceValue } from "./instance.js";

type AddressBucket = ReadonlyMap<string, EffectAddress>;

type LifetimeProjection = ReadonlyMap<string, AddressBucket>;

const projections = new WeakMap<
    CombatWork["units"],
    WeakMap<CombatWork["removals"], LifetimeProjection>
>();

function instancesOf(unit: Unit | undefined): readonly EffectInstanceValue[] | undefined {
    return unit !== undefined && hasEffects(unit) ? unit.effects.instances : undefined;
}

function addressKey(address: EffectAddress): string {
    return `${address.unitId}:${address.instanceId}`;
}

function relationKeys(instance: EffectInstanceValue): readonly string[] {
    const keys: string[] = [];

    if (instance.scope !== null) {
        keys.push(`unit:${instance.scope.unitId}`);

        if (instance.scope.type === "EXECUTION") {
            keys.push(`execution:${instance.scope.unitId}:${instance.scope.executionId}`);
        }
    }
    if (instance.parent !== null) {
        keys.push(`parent:${addressKey(instance.parent)}`);
    }

    return keys;
}

function storedProjection(work: CombatWork): LifetimeProjection | undefined {
    return projections.get(work.units)?.get(work.removals);
}

function storeProjection(work: CombatWork, projection: LifetimeProjection): void {
    let byRemovals = projections.get(work.units);

    if (byRemovals === undefined) {
        byRemovals = new WeakMap();
        projections.set(work.units, byRemovals);
    }

    byRemovals.set(work.removals, projection);
}

function projectLifetimes(work: CombatWork): LifetimeProjection {
    const projection = new Map<string, Map<string, EffectAddress>>();
    const ids = new Set([...work.battlefield.unitIds, ...work.units.keys()]);

    for (const unitId of ids) {
        if (work.removals.has(unitId)) {
            continue;
        }

        const unit = work.units.get(unitId) ?? work.battlefield.getUnit(unitId);

        for (const instance of instancesOf(unit) ?? []) {
            const address = Object.freeze({ unitId, instanceId: instance.id });

            for (const key of relationKeys(instance)) {
                let bucket = projection.get(key);

                if (bucket === undefined) {
                    bucket = new Map();
                    projection.set(key, bucket);
                }

                bucket.set(addressKey(address), address);
            }
        }
    }

    return projection;
}

function addressesFor(work: CombatWork, key: string): readonly EffectAddress[] {
    let projection = storedProjection(work);

    if (projection === undefined) {
        projection = projectLifetimes(work);
        storeProjection(work, projection);
    }

    return Object.freeze(
        [...(projection.get(key)?.values() ?? [])].sort(
            (left, right) => left.unitId - right.unitId || left.instanceId - right.instanceId,
        ),
    );
}

export function deriveEffectLifetimeProjection(
    previous: CombatWork,
    next: CombatWork,
    previousUnit: Unit | undefined,
    nextUnit: Unit | undefined,
): void {
    const projection = storedProjection(previous);

    if (projection === undefined) {
        return;
    }

    const previousInstances = instancesOf(previousUnit);
    const nextInstances = instancesOf(nextUnit);

    if (previousInstances === nextInstances) {
        storeProjection(next, projection);

        return;
    }

    const unitId = (nextUnit ?? previousUnit)!.id;
    const previousById = new Map(previousInstances?.map((instance) => [instance.id, instance]));
    let updated: Map<string, AddressBucket> | undefined;
    const editedBuckets = new Map<string, Map<string, EffectAddress>>();

    const editBucket = (key: string): Map<string, EffectAddress> => {
        let bucket = editedBuckets.get(key);

        if (bucket === undefined) {
            updated ??= new Map(projection);
            bucket = new Map(projection.get(key));
            editedBuckets.set(key, bucket);
        }

        return bucket;
    };

    const changeRelations = (
        before: EffectInstanceValue | undefined,
        after: EffectInstanceValue | undefined,
    ): void => {
        if (before === after) {
            return;
        }

        const address = Object.freeze({ unitId, instanceId: (after ?? before)!.id });
        const beforeKeys = before === undefined ? [] : relationKeys(before);
        const afterKeys = after === undefined ? [] : relationKeys(after);

        for (const key of beforeKeys) {
            if (!afterKeys.includes(key)) {
                editBucket(key).delete(addressKey(address));
            }
        }
        for (const key of afterKeys) {
            if (!beforeKeys.includes(key)) {
                editBucket(key).set(addressKey(address), address);
            }
        }
    };

    for (const instance of nextInstances ?? []) {
        changeRelations(previousById.get(instance.id), instance);
        previousById.delete(instance.id);
    }
    for (const instance of previousById.values()) {
        changeRelations(instance, undefined);
    }

    if (updated !== undefined) {
        for (const [key, bucket] of editedBuckets) {
            if (bucket.size === 0) {
                updated.delete(key);
            } else {
                updated.set(key, bucket);
            }
        }
    }

    storeProjection(next, updated ?? projection);
}

export function effectAddressesOwnedByUnit(
    work: CombatWork,
    unitId: UnitId,
): readonly EffectAddress[] {
    return addressesFor(work, `unit:${unitId}`);
}

export function effectAddressesOwnedByExecution(
    work: CombatWork,
    unitId: UnitId,
    executionId: number,
): readonly EffectAddress[] {
    return addressesFor(work, `execution:${unitId}:${executionId}`);
}

export function effectChildAddresses(
    work: CombatWork,
    parent: EffectAddress,
): readonly EffectAddress[] {
    return addressesFor(work, `parent:${addressKey(parent)}`);
}
