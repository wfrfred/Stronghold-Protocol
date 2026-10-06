import type { BattlefieldView } from "../battlefield/runtime.js";
import { World } from "../geometry/coordinate.js";
import { RangeGrid } from "../geometry/range.js";
import type { TargetProfile } from "../unit/capability/action.js";
import { areHostile, type Allegiance } from "../unit/capability/allegiance.js";
import { isSpatiallyPresent } from "../unit/capability/presence.js";
import { hasTargetable, type Targetable } from "../unit/capability/targetable.js";
import { hasVitality, type Vitality } from "../unit/capability/vitality.js";
import type { Unit } from "../unit/unit.js";

export type AttackTarget = Unit & Vitality & Targetable & Allegiance;

export type CombatTargetingView = Pick<
    BattlefieldView,
    "unitIds" | "getUnit" | "blockerOf" | "blockedBy"
>;

export function canTargetUnit(
    source: Unit,
    target: Unit,
    profile: TargetProfile,
): target is AttackTarget {
    return (
        hasVitality(target) &&
        target.vitality.hp > 0 &&
        hasTargetable(target) &&
        target.targetable.enabled &&
        (target.targetable.layer === "GROUND" || profile.canTargetAir) &&
        isSpatiallyPresent(target) &&
        areHostile(source, target)
    );
}

export function selectAttackTarget(
    source: Unit,
    profile: TargetProfile,
    battlefield: CombatTargetingView,
): AttackTarget | null {
    const blockerId = battlefield.blockerOf(source.id);
    const blocking = new Set(battlefield.blockedBy(source.id));

    if (blockerId !== undefined) {
        blocking.add(blockerId);
    }

    const range = profile.range;
    const rangeTiles =
        range.type === "GRID"
            ? RangeGrid.project(range.offsets, World.toTile(source.position), range.direction)
            : [];
    let selected: AttackTarget | null = null;
    let selectedBlocked = false;
    let selectedDistance = Infinity;

    for (const id of battlefield.unitIds) {
        const target = battlefield.getUnit(id)!;

        if (!canTargetUnit(source, target, profile)) {
            continue;
        }

        const blocked = blocking.has(id);
        let inRange: boolean;

        switch (range.type) {
            case "BLOCKER":
                inRange = id === blockerId;
                break;

            case "RADIUS":
                inRange =
                    blocked || World.withinDistance(source.position, target.position, range.radius);
                break;

            case "GRID": {
                const tile = World.toTile(target.position);
                inRange =
                    blocked || rangeTiles.some(([row, col]) => row === tile[0] && col === tile[1]);
                break;
            }
        }

        if (!inRange) {
            continue;
        }

        const distance = World.distanceSquared(source.position, target.position);
        const preferred =
            selected === null ||
            (blocked && !selectedBlocked) ||
            (blocked === selectedBlocked &&
                (distance < selectedDistance ||
                    (distance === selectedDistance && id < selected.id)));

        if (preferred) {
            selected = target;
            selectedBlocked = blocked;
            selectedDistance = distance;
        }
    }

    return selected;
}
