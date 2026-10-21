import type { Ref } from "../../../common/ref.js";
import type { State as BattleState } from "../../battle/state.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import { geometrySweepsHit, rangeOverlapsHit } from "../../geometry/intersection.js";
import type { RangeGeometry, ShapeGeometry } from "../../geometry/shape.js";
import { hasHitbox, type Hitbox } from "../../unit/capability/hitbox/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import { ref } from "../../unit/query.js";
import type { Unit } from "../../unit/unit.js";

export function overlaps(
    range: RangeGeometry,
    origin: WorldPosition,
    self: Unit & Hitbox,
): boolean {
    return rangeOverlapsHit(range, origin, self.position, self.definition.hitbox.geometry);
}

export function overlap(
    battle: BattleState,
    range: RangeGeometry,
    origin: WorldPosition,
): Ref<Unit & Hitbox>[] {
    const matches: Ref<Unit & Hitbox>[] = [];

    for (const self of battle.battlefield.units.values()) {
        if (hasHitbox(self) && isSpatiallyPresent(self) && overlaps(range, origin, self)) {
            matches.push(ref(self));
        }
    }

    return matches;
}

export function sweep(
    battle: BattleState,
    geometry: ShapeGeometry,
    from: WorldPosition,
    to: WorldPosition,
): Ref<Unit & Hitbox>[] {
    const matches: Ref<Unit & Hitbox>[] = [];

    for (const self of battle.battlefield.units.values()) {
        if (
            hasHitbox(self) &&
            isSpatiallyPresent(self) &&
            geometrySweepsHit(geometry, from, to, self.position, self.definition.hitbox.geometry)
        ) {
            matches.push(ref(self));
        }
    }

    return matches;
}
