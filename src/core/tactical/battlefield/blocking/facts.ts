import { World, type WorldPosition } from "../../geometry/coordinate.js";
import { hasAllegiance, type Side } from "../../unit/capability/allegiance/capability.js";
import { hasBlockable } from "../../unit/capability/blocking/blockable.js";
import { canBlock, hasBlocker, resolveCapacity } from "../../unit/capability/blocking/blocker.js";
import { hasTileBinding } from "../../unit/capability/tile-binding/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import { hasSpatial } from "../../unit/capability/spatial/capability.js";
import { hasVitality } from "../../unit/capability/vitality/capability.js";
import type { Unit } from "../../unit/unit.js";
import { BattlefieldMap } from "../map/map.js";

export interface BlockerFacts {
    readonly enabled: boolean;
    readonly capacity: number;
    readonly radius: number;
}

export interface BlockableFacts {
    readonly enabled: boolean;
    readonly weight: number;
}

export interface BlockingFacts {
    readonly position: WorldPosition;
    readonly active: boolean;
    readonly ground: boolean;
    readonly highland: boolean;
    readonly side: Side | undefined;
    readonly blocker: BlockerFacts | undefined;
    readonly blockable: BlockableFacts | undefined;
}

export function readBlockableFacts(unit: Unit): BlockableFacts | undefined {
    return hasBlockable(unit) ? unit.blockable : undefined;
}

export function readBlockingFacts(unit: Unit): BlockingFacts {
    const active = isSpatiallyPresent(unit) && (!hasVitality(unit) || unit.vitality.hp > 0);
    const blocker = hasBlocker(unit)
        ? {
              enabled: canBlock(unit),
              capacity: resolveCapacity(unit.definition.blocker, unit.blocker),
              radius: unit.blocker.geometry.radius,
          }
        : undefined;

    return {
        position: unit.position,
        active,
        ground: !hasSpatial(unit) || unit.spatial.layer === "GROUND",
        highland: hasTileBinding(unit) && unit.definition.tileBinding.heightType === "HIGHLAND",
        side: hasAllegiance(unit) ? unit.allegiance.side : undefined,
        blocker,
        blockable: readBlockableFacts(unit),
    };
}

export function isGroundBlocker(map: BattlefieldMap, facts: BlockingFacts): boolean {
    if (facts.blocker?.enabled !== true || !facts.active) {
        return false;
    }

    const tile = BattlefieldMap.get(map, World.toTile(facts.position));

    return tile?.passableMask === "ALL" || tile?.passableMask === "WALK_ONLY";
}

export function sameBlockingFacts(
    map: BattlefieldMap,
    left: BlockingFacts,
    right: BlockingFacts,
): boolean {
    return (
        left.position[0] === right.position[0] &&
        left.position[1] === right.position[1] &&
        left.active === right.active &&
        left.ground === right.ground &&
        left.highland === right.highland &&
        isGroundBlocker(map, left) === isGroundBlocker(map, right) &&
        left.blocker?.enabled === right.blocker?.enabled &&
        left.blocker?.capacity === right.blocker?.capacity &&
        left.blocker?.radius === right.blocker?.radius &&
        left.blockable?.enabled === right.blockable?.enabled &&
        left.blockable?.weight === right.blockable?.weight &&
        left.side === right.side
    );
}
