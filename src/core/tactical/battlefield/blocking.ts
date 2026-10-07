import { World } from "../geometry/coordinate.js";
import { areHostile } from "../unit/capability/allegiance.js";
import { hasBlockable, hasBlocker } from "../unit/capability/blocking.js";
import { isSpatiallyPresent } from "../unit/capability/presence.js";
import { hasSpatial } from "../unit/capability/spatial.js";
import { hasVitality } from "../unit/capability/vitality.js";
import type { Unit, UnitId } from "../unit/unit.js";
import { hasTileBindingDefinition } from "../unit/capability/deployment.js";
import type { SupportRelation } from "./support.js";
import { BattlefieldMap } from "./map.js";

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

export function canBlockGround(unit: Unit, map: BattlefieldMap): boolean {
    if (!hasBlocker(unit) || !unit.blocker.enabled || !isActive(unit)) {
        return false;
    }

    const tile = BattlefieldMap.get(map, World.toTile(unit.position));

    return tile?.passableMask === "ALL" || tile?.passableMask === "WALK_ONLY";
}

function canBlock(
    map: BattlefieldMap,
    blocker: Unit,
    blocked: Unit,
    units: ReadonlyMap<UnitId, Unit>,
    supports: readonly SupportRelation[],
): boolean {
    const supportId = supports.find(
        (relation) => relation.supportedUnitId === blocker.id,
    )?.supportUnitId;
    const support = supportId === undefined ? undefined : units.get(supportId);

    if (
        support !== undefined &&
        hasTileBindingDefinition(support.definition) &&
        support.definition.tileBinding.heightType === "HIGHLAND"
    ) {
        return false;
    }

    return (
        canBlockGround(blocker, map) &&
        hasBlockable(blocked) &&
        blocked.blockable.enabled &&
        (!hasSpatial(blocked) || blocked.spatial.layer === "GROUND") &&
        isActive(blocked) &&
        areHostile(blocker, blocked)
    );
}

export function reconcileBlockingRelations(
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
    relations: readonly BlockingRelation[],
    supports: readonly SupportRelation[] = [],
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
            !canBlock(map, blocker, blocked, units, supports) ||
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
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
    previous: readonly BlockingRelation[],
    supports: readonly SupportRelation[] = [],
): readonly BlockingRelation[] {
    const retained = reconcileBlockingRelations(map, units, previous, supports);
    const blockedIds = new Set(retained.map((relation) => relation.blockedUnitId));
    const used = new Map<UnitId, number>();
    const additions: BlockingRelation[] = [];
    const ordered = [...units.values()].sort((left, right) => left.id - right.id);
    const blockers = ordered.filter(hasBlocker);

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
                !canBlock(map, blocker, blocked, units, supports) ||
                (used.get(blocker.id) ?? 0) + blocked.blockable.weight > blocker.blocker.capacity
            ) {
                continue;
            }

            const distance = World.distanceSquared(blocker.position, blocked.position);
            const radius = blocker.blocker.geometry.radius;

            if (distance <= radius * radius && distance < nearestDistance) {
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
