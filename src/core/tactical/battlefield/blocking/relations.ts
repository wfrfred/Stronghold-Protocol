import { World } from "../../geometry/coordinate.js";
import { areHostileSides } from "../../unit/capability/allegiance.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import { hasBlocker } from "../../unit/capability/blocking/capability.js";
import type { SupportRelation } from "../support/relations.js";
import { BattlefieldMap } from "../map/map.js";
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

function canBlockFrom(
    map: BattlefieldMap,
    blockerId: UnitId,
    blocker: BlockingFacts,
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

    return isGroundBlocker(map, blocker);
}

function canBlockTarget(blocker: BlockingFacts, blocked: BlockingFacts): boolean {
    return (
        blocked.blockable?.enabled === true &&
        blocked.ground &&
        blocked.active &&
        areHostileSides(blocker.side, blocked.side)
    );
}

function reconcileBlockingRelations(
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
            !canBlockFrom(map, blocker.id, blockerFacts, units, supports) ||
            !canBlockTarget(blockerFacts, blockedFacts) ||
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

export function updateBlockingRelations(
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
    previous: readonly BlockingRelation[],
    unitsByTile: ReadonlyMap<number, ReadonlySet<UnitId>>,
    supports: readonly SupportRelation[] = [],
): readonly BlockingRelation[] {
    const retained = reconcileBlockingRelations(map, units, previous, supports);
    const blockedIds = new Set(retained.map((relation) => relation.blockedUnitId));
    const used = new Map<UnitId, number>();
    const additions: BlockingRelation[] = [];

    for (const relation of retained) {
        used.set(
            relation.blockerUnitId,
            (used.get(relation.blockerUnitId) ?? 0) +
                readBlockableFacts(units.get(relation.blockedUnitId)!)!.weight,
        );
    }

    const blockers = [...units.values()].flatMap((unit) => {
        if (!hasBlocker(unit)) {
            return [];
        }

        const facts = readBlockingFacts(unit);
        const remaining = facts.blocker!.capacity - (used.get(unit.id) ?? 0);

        return remaining > 0 && canBlockFrom(map, unit.id, facts, units, supports)
            ? [{ unit, facts, radius: facts.blocker!.radius, remaining }]
            : [];
    });

    if (blockers.length === 0) {
        return retained;
    }

    const candidates = new Map<
        UnitId,
        { weight: number; blockers: { blocker: (typeof blockers)[number]; distance: number }[] }
    >();

    const addCandidate = (blocker: (typeof blockers)[number], unitId: UnitId): void => {
        if (blockedIds.has(unitId)) {
            return;
        }

        const blocked = units.get(unitId)!;
        const blockable = readBlockableFacts(blocked);

        if (
            blockable === undefined ||
            blockable.weight > blocker.remaining ||
            !canBlockTarget(blocker.facts, readBlockingFacts(blocked))
        ) {
            return;
        }

        const distance = World.distanceSquared(blocker.unit.position, blocked.position);

        if (distance > blocker.radius * blocker.radius) {
            return;
        }

        let candidate = candidates.get(unitId);

        if (candidate === undefined) {
            candidate = { weight: blockable.weight, blockers: [] };
            candidates.set(unitId, candidate);
        }

        candidate.blockers.push({ blocker, distance });
    };

    const edgeBlockers: typeof blockers = [];

    for (const blocker of blockers) {
        const [x, y] = blocker.unit.position;
        const radius = blocker.radius;
        const firstRow = Math.ceil(y - radius - 0.5);
        const lastRow = Math.floor(y + radius + 0.5);
        const firstColumn = Math.ceil(x - radius - 0.5);
        const lastColumn = Math.floor(x + radius + 0.5);

        for (let row = Math.max(0, firstRow); row <= Math.min(map.rows - 1, lastRow); row++) {
            for (
                let column = Math.max(0, firstColumn);
                column <= Math.min(map.columns - 1, lastColumn);
                column++
            ) {
                for (const id of unitsByTile.get(row * map.columns + column) ?? []) {
                    addCandidate(blocker, id);
                }
            }
        }

        if (firstRow < 0 || lastRow >= map.rows || firstColumn < 0 || lastColumn >= map.columns) {
            edgeBlockers.push(blocker);
        }
    }

    if (edgeBlockers.length > 0) {
        for (const unit of units.values()) {
            const facts = readBlockingFacts(unit);

            if (
                facts.blockable === undefined ||
                !facts.active ||
                BattlefieldMap.contains(map, World.toTile(unit.position))
            ) {
                continue;
            }

            for (const blocker of edgeBlockers) {
                addCandidate(blocker, unit.id);
            }
        }
    }

    let available = blockers.length;

    for (const [unitId, candidate] of [...candidates].sort(([left], [right]) => left - right)) {
        candidate.blockers.sort(
            (left, right) =>
                left.distance - right.distance || left.blocker.unit.id - right.blocker.unit.id,
        );
        const chosen = candidate.blockers.find(
            ({ blocker }) => blocker.remaining >= candidate.weight,
        )?.blocker;

        if (chosen === undefined) {
            continue;
        }

        additions.push({ blockerUnitId: chosen.unit.id, blockedUnitId: unitId });
        chosen.remaining -= candidate.weight;

        if (chosen.remaining === 0 && --available === 0) {
            break;
        }
    }

    return additions.length === 0 ? retained : [...retained, ...additions];
}
