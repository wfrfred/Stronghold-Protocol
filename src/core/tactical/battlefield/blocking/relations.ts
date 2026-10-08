import { World } from "../../geometry/coordinate.js";
import { areHostileSides } from "../../unit/capability/allegiance.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { SupportRelation } from "../support/relations.js";
import type { BattlefieldMap } from "../map/map.js";
import {
    isGroundBlocker,
    readBlockableFacts,
    readBlockingFacts,
    type BlockingFacts,
} from "./facts.js";

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

export function canBlockGround(unit: Unit, map: BattlefieldMap): boolean {
    return isGroundBlocker(map, readBlockingFacts(unit));
}

function canBlock(
    map: BattlefieldMap,
    blockerId: UnitId,
    blocker: BlockingFacts,
    blocked: BlockingFacts,
    units: ReadonlyMap<UnitId, Unit>,
    supports: readonly SupportRelation[],
): boolean {
    const supportId = supports.find(
        (relation) => relation.supportedUnitId === blockerId,
    )?.supportUnitId;
    const support = supportId === undefined ? undefined : units.get(supportId);

    if (support !== undefined && readBlockingFacts(support).highland) {
        return false;
    }

    return (
        isGroundBlocker(map, blocker) &&
        blocked.blockable?.enabled === true &&
        blocked.ground &&
        blocked.active &&
        areHostileSides(blocker.side, blocked.side)
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
        const blockerFacts = blocker === undefined ? undefined : readBlockingFacts(blocker);
        const blockedFacts = blocked === undefined ? undefined : readBlockingFacts(blocked);

        if (
            blocker === undefined ||
            blocked === undefined ||
            blockerFacts?.blocker === undefined ||
            blockedFacts?.blockable === undefined ||
            !canBlock(map, blocker.id, blockerFacts, blockedFacts, units, supports) ||
            blockedIds.has(blocked.id)
        ) {
            continue;
        }

        const capacity = (used.get(blocker.id) ?? 0) + blockedFacts.blockable.weight;

        if (capacity > blockerFacts.blocker.capacity) {
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

        const blocked = readBlockableFacts(units.get(relation.blockedUnitId)!);

        if (blocked !== undefined) {
            used += blocked.weight;
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
    const blockers = ordered.flatMap((unit) => {
        const facts = readBlockingFacts(unit);

        return facts.blocker === undefined ? [] : [{ unit, facts, blocker: facts.blocker }];
    });

    for (const blocker of blockers) {
        used.set(blocker.unit.id, blockingUsedCapacity(units, retained, blocker.unit.id));
    }

    for (const blocked of ordered) {
        const blockable = readBlockableFacts(blocked);

        if (blockable === undefined || blockedIds.has(blocked.id)) {
            continue;
        }

        const blockedFacts = readBlockingFacts(blocked);
        let nearest: (typeof blockers)[number] | undefined;
        let nearestDistance = Infinity;

        for (const blocker of blockers) {
            if (
                !canBlock(map, blocker.unit.id, blocker.facts, blockedFacts, units, supports) ||
                (used.get(blocker.unit.id) ?? 0) + blockable.weight > blocker.blocker.capacity
            ) {
                continue;
            }

            const distance = World.distanceSquared(blocker.unit.position, blocked.position);
            const radius = blocker.blocker.radius;

            if (distance <= radius * radius && distance < nearestDistance) {
                nearest = blocker;
                nearestDistance = distance;
            }
        }

        if (nearest === undefined) {
            continue;
        }

        additions.push({ blockerUnitId: nearest.unit.id, blockedUnitId: blocked.id });
        blockedIds.add(blocked.id);
        used.set(nearest.unit.id, (used.get(nearest.unit.id) ?? 0) + blockable.weight);
    }

    return additions.length === 0 ? retained : [...retained, ...additions];
}
