import { World } from "../geometry/coordinate.js";
import { areHostile } from "../unit/capability/allegiance.js";
import {
    hasBlockable,
    hasBlocker,
    hasBlockerDefinition,
    type Blocker,
    type BlockingUnitDefinition,
} from "../unit/capability/blocking.js";
import { isSpatiallyPresent } from "../unit/capability/presence.js";
import { hasTargetable } from "../unit/capability/targetable.js";
import { hasVitality } from "../unit/capability/vitality.js";
import type { Unit, UnitId } from "../unit/unit.js";

export interface BlockingRelation {
    readonly blockerUnitId: UnitId;
    readonly blockedUnitId: UnitId;
}

export function releaseBlockingRelations(
    relations: readonly BlockingRelation[],
    unitId: UnitId,
): readonly BlockingRelation[] {
    const retained = relations.filter(
        (relation) => relation.blockerUnitId !== unitId && relation.blockedUnitId !== unitId,
    );

    return retained.length === relations.length ? relations : retained;
}

function isActive(unit: Unit): boolean {
    return isSpatiallyPresent(unit) && (!hasVitality(unit) || unit.vitality.hp > 0);
}

function canBlock(blocker: Unit, blocked: Unit): boolean {
    return (
        hasBlocker(blocker) &&
        hasBlockerDefinition(blocker.definition) &&
        blocker.blocker.enabled &&
        hasBlockable(blocked) &&
        blocked.blockable.enabled &&
        (!hasTargetable(blocked) || blocked.targetable.layer === "GROUND") &&
        isActive(blocker) &&
        isActive(blocked) &&
        areHostile(blocker, blocked)
    );
}

export function reconcileBlockingRelations(
    units: ReadonlyMap<UnitId, Unit>,
    relations: readonly BlockingRelation[],
): readonly BlockingRelation[] {
    const used = new Map<UnitId, number>();
    const blockedIds = new Set<UnitId>();
    const retained: BlockingRelation[] = [];

    for (const relation of relations) {
        const blocker = units.get(relation.blockerUnitId);
        const blocked = units.get(relation.blockedUnitId);

        if (
            blocker === undefined ||
            blocked === undefined ||
            !hasBlocker(blocker) ||
            !hasBlockable(blocked) ||
            !canBlock(blocker, blocked) ||
            blockedIds.has(blocked.id)
        ) {
            continue;
        }

        const capacity = (used.get(blocker.id) ?? 0) + blocked.blockable.weight;

        if (capacity > blocker.blocker.capacity) {
            continue;
        }

        retained.push(relation);
        blockedIds.add(blocked.id);
        used.set(blocker.id, capacity);
    }

    return retained.length === relations.length ? relations : retained;
}

export function blockingUsedCapacity(
    units: ReadonlyMap<UnitId, Unit>,
    relations: readonly BlockingRelation[],
    blockerUnitId: UnitId,
): number {
    let used = 0;

    for (const relation of relations) {
        if (relation.blockerUnitId !== blockerUnitId) {
            continue;
        }

        const blocked = units.get(relation.blockedUnitId)!;

        if (hasBlockable(blocked)) {
            used += blocked.blockable.weight;
        }
    }

    return used;
}

export function acquireBlockingRelations(
    units: ReadonlyMap<UnitId, Unit>,
    previous: readonly BlockingRelation[],
): readonly BlockingRelation[] {
    const retained = reconcileBlockingRelations(units, previous);
    const blockedIds = new Set(retained.map((relation) => relation.blockedUnitId));
    const used = new Map<UnitId, number>();
    const additions: BlockingRelation[] = [];
    const ordered = [...units.values()].sort((left, right) => left.id - right.id);
    const blockers = ordered.filter(
        (unit): unit is Unit<BlockingUnitDefinition> & Blocker =>
            hasBlocker(unit) && hasBlockerDefinition(unit.definition),
    );

    for (const blocker of blockers) {
        used.set(blocker.id, blockingUsedCapacity(units, retained, blocker.id));
    }

    for (const blocked of ordered) {
        if (!hasBlockable(blocked) || blockedIds.has(blocked.id)) {
            continue;
        }

        let nearest: (typeof blockers)[number] | undefined;
        let nearestDistance = Infinity;

        for (const blocker of blockers) {
            if (
                !canBlock(blocker, blocked) ||
                (used.get(blocker.id) ?? 0) + blocked.blockable.weight > blocker.blocker.capacity
            ) {
                continue;
            }

            const distance = World.distanceSquared(blocker.position, blocked.position);
            const radius = blocker.definition.blocker.contactRadius;

            if (distance < radius * radius && distance < nearestDistance) {
                nearest = blocker;
                nearestDistance = distance;
            }
        }

        if (nearest === undefined) {
            continue;
        }

        additions.push({ blockerUnitId: nearest.id, blockedUnitId: blocked.id });
        blockedIds.add(blocked.id);
        used.set(nearest.id, (used.get(nearest.id) ?? 0) + blocked.blockable.weight);
    }

    return additions.length === 0 ? retained : [...retained, ...additions];
}
