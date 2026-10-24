import type { Ref } from "../../../common/ref.js";
import { World } from "../../geometry/coordinate.js";
import * as battlefield from "../../battlefield/state.js";
import { BattlefieldMap } from "../../battlefield/map/map.js";
import { areHostile, hasAllegiance } from "../../unit/capability/allegiance/capability.js";
import {
    canBlock,
    hasBlocker,
    resolveCapacity,
    type Blocker,
} from "../../unit/capability/blocking/blocker.js";
import {
    canBeBlocked,
    hasBlockable,
    resolveVolume,
    type Blockable,
} from "../../unit/capability/blocking/blockable.js";
import { hasLayer } from "../../unit/capability/layer/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import * as support from "../../battlefield/support.js";
import { hasVitality } from "../../unit/capability/vitality/capability.js";
import * as units from "../../unit/query.js";
import type { Unit } from "../../unit/unit.js";
import {
    appendEvents,
    setBattlefield,
    updateUnit,
    type State as BattleState,
    type Result,
} from "../state.js";
import type { Change, Relation } from "./contract.js";
import * as hooks from "./hook.js";
import { hasRelation, relations, usedCapacity } from "./query.js";

function isActive(unit: Unit): boolean {
    return (
        unit.lifecycle === "PRESENT" &&
        isSpatiallyPresent(unit) &&
        (!hasVitality(unit) || unit.vitality.hp > 0)
    );
}

function canSearch(battle: BattleState, unit: Unit & Blocker): boolean {
    if (!isActive(unit) || !hasAllegiance(unit) || !canBlock(unit)) {
        return false;
    }

    const relation = support.of(battle.battlefield, units.ref(unit));

    if (relation?.support.definition.tileBinding.heightType === "HIGHLAND") {
        return false;
    }

    const tile = BattlefieldMap.get(battle.battlefield.map, World.toTile(unit.position));

    return tile?.meleeBlockable === true;
}

function canRetain(
    battle: BattleState,
    blocker: Unit & Blocker,
    target: Unit & Blockable,
): boolean {
    return (
        canSearch(battle, blocker) &&
        hasAllegiance(blocker) &&
        isActive(target) &&
        canBeBlocked(target) &&
        (!hasLayer(target) || target.layer.type === "GROUND") &&
        hasAllegiance(target) &&
        areHostile(blocker, target)
    );
}

function canAcquire(
    battle: BattleState,
    blocker: Unit & Blocker,
    target: Unit & Blockable,
): boolean {
    if (!canRetain(battle, blocker, target)) {
        return false;
    }

    const distance = World.distanceSquared(blocker.position, target.position);
    const radius = blocker.blocker.geometry.radius;
    const capacity = resolveCapacity(blocker.definition.blocker, blocker.blocker);
    const volume = resolveVolume(target.definition.blockable, target.blockable);

    return (
        distance <= radius * radius && usedCapacity(battle, units.ref(blocker)) + volume <= capacity
    );
}

export function synchronize(
    battle: BattleState,
    previousUnit: Unit,
    nextUnit: Unit,
): Result<Change | undefined> {
    const previous = hasBlockable(previousUnit) ? previousUnit.blockable.blocker : null;
    const next = hasBlockable(nextUnit) ? nextUnit.blockable.blocker : null;

    if (previous?.id === next?.id) {
        return { state: battle, value: undefined };
    }

    if (previous !== null && next !== null) {
        throw new RangeError("blocking ownership must be released before reassignment");
    }

    if (next !== null && hasBlockable(nextUnit)) {
        const owner = units.get(battle, next);

        if (owner === undefined) {
            throw new RangeError(`unknown blocker: ${next.id}`);
        }

        if (!canAcquire(battle, owner, nextUnit)) {
            throw new RangeError("blocking ownership requires acquisition eligibility");
        }

        const target = units.ref(nextUnit);
        const updated = {
            ...owner,
            blocker: { ...owner.blocker, blocked: [...owner.blocker.blocked, target] },
        };

        return {
            state: setBattlefield(battle, battlefield.replaceUnit(battle.battlefield, updated)),
            value: { type: "ACQUIRED", relation: { blocker: next, blocked: target } },
        };
    }

    if (previous !== null && hasBlockable(previousUnit)) {
        const owner = units.get(battle, previous);
        const target = owner?.blocker.blocked.find((entry) => entry.id === previousUnit.id);

        if (owner === undefined || target === undefined) {
            return { state: battle, value: undefined };
        }

        const updated = {
            ...owner,
            blocker: {
                ...owner.blocker,
                blocked: owner.blocker.blocked.filter((entry) => entry !== target),
            },
        };

        return {
            state: setBattlefield(battle, battlefield.replaceUnit(battle.battlefield, updated)),
            value: { type: "RELEASED", relation: { blocker: previous, blocked: target } },
        };
    }

    return { state: battle, value: undefined };
}

export function notify(battle: BattleState, change: Change): BattleState {
    const { relation } = change;
    battle = appendEvents(battle, [
        {
            type: change.type === "ACQUIRED" ? "BLOCKING_ACQUIRED" : "BLOCKING_RELEASED",
            blockerUnitId: relation.blocker.id,
            blockedUnitId: relation.blocked.id,
            tick: battle.tick,
        },
    ]);

    return hooks.dispatch(battle, change.type === "ACQUIRED" ? "acquired" : "released", relation);
}

export function capture(battle: BattleState, reference: Ref<Unit>): readonly Relation[] {
    return relations(battle).filter(
        (relation) => relation.blocker.id === reference.id || relation.blocked.id === reference.id,
    );
}

function releaseRelation(battle: BattleState, relation: Relation): BattleState {
    if (!hasRelation(battle, relation)) {
        return battle;
    }

    const target = units.get(battle, relation.blocked)!;

    return updateUnit(battle, {
        ...target,
        blockable: { ...target.blockable, blocker: null },
    });
}

export function releaseCaptured(battle: BattleState, captured: readonly Relation[]): BattleState {
    for (const relation of captured) {
        battle = releaseRelation(battle, relation);
    }

    return battle;
}

export function release(battle: BattleState, reference: Ref<Unit>): BattleState {
    return releaseCaptured(battle, capture(battle, reference));
}

export function maintain(battle: BattleState): BattleState {
    for (;;) {
        const invalid = relations(battle).find((relation) => {
            const blocker = units.get(battle, relation.blocker);
            const target = units.get(battle, relation.blocked);

            return (
                blocker !== undefined && target !== undefined && !canRetain(battle, blocker, target)
            );
        });

        if (invalid !== undefined) {
            battle = releaseRelation(battle, invalid);
            continue;
        }

        const overflowing = units
            .all(battle)
            .filter(hasBlocker)
            .find(
                (unit) =>
                    usedCapacity(battle, units.ref(unit)) >
                    resolveCapacity(unit.definition.blocker, unit.blocker),
            );

        if (overflowing === undefined) {
            return battle;
        }

        battle = releaseRelation(battle, {
            blocker: units.ref(overflowing),
            blocked: overflowing.blocker.blocked.at(-1)!,
        });
    }
}

function tryAcquire(
    battle: BattleState,
    blockerRef: Ref<Unit & Blocker>,
    targetRef: Ref<Unit & Blockable>,
): BattleState {
    const blocker = units.get(battle, blockerRef);
    const target = units.get(battle, targetRef);

    if (
        blocker === undefined ||
        target?.blockable.blocker !== null ||
        !canAcquire(battle, blocker, target)
    ) {
        return battle;
    }

    return updateUnit(battle, {
        ...target,
        blockable: { ...target.blockable, blocker: units.ref(blocker) },
    });
}

export function search(battle: BattleState, reference: Ref<Unit & Blocker>): BattleState {
    const blocker = units.get(battle, reference);

    if (blocker === undefined || !canSearch(battle, blocker)) {
        return battle;
    }

    const radius = blocker.blocker.geometry.radius;
    const candidates = [
        ...units
            .all(battle)
            .filter(hasBlockable)
            .filter(
                (target) =>
                    canRetain(battle, blocker, target) &&
                    World.distanceSquared(blocker.position, target.position) <= radius * radius,
            )
            .map((target) => ({
                reference: units.ref(target),
                distance: World.distanceSquared(blocker.position, target.position),
            }))
            .toArray(),
    ].sort(
        (left, right) => left.distance - right.distance || left.reference.id - right.reference.id,
    );

    for (const candidate of candidates) {
        battle = tryAcquire(battle, reference, candidate.reference);
    }

    return battle;
}

export function advance(battle: BattleState): BattleState {
    const candidates = units.all(battle).filter(hasBlocker).map(units.ref).toArray();

    for (const reference of candidates) {
        battle = search(battle, reference);
    }

    return battle;
}
