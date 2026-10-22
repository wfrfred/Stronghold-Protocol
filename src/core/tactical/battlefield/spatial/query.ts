import type { Ref } from "../../../common/ref.js";
import { sort } from "../../../common/collection.js";
import type { State as BattleState } from "../../battle/state.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import * as intersection from "../../geometry/intersection.js";
import type { Range } from "../../geometry/range.js";
import type { Shape } from "../../geometry/shape.js";
import { hasHitbox, type Hitbox } from "../../unit/capability/hitbox/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import * as units from "../../unit/query.js";
import type { Unit } from "../../unit/unit.js";

export function within(
    battle: BattleState,
    range: Range,
    origin: WorldPosition,
): readonly Ref<Unit>[] {
    return units
        .all(battle)
        .filter((unit) => unit.lifecycle === "PRESENT" && isSpatiallyPresent(unit))
        .filter((unit) => intersection.contains(range, origin, unit.position))
        .map(units.ref)
        .toArray();
}

export function overlap(
    battle: BattleState,
    range: Range,
    origin: WorldPosition,
): readonly Ref<Unit & Hitbox>[] {
    return units
        .all(battle)
        .filter((unit) => unit.lifecycle === "PRESENT" && isSpatiallyPresent(unit))
        .filter(hasHitbox)
        .filter((unit) =>
            intersection.overlaps(range, origin, unit.definition.hitbox.shape, unit.position),
        )
        .map(units.ref)
        .toArray();
}

export interface Contact {
    readonly target: Ref<Unit & Hitbox>;
    readonly fraction: number;
}

export function sweep(
    battle: BattleState,
    shape: Shape,
    from: WorldPosition,
    to: WorldPosition,
): readonly Contact[] {
    const contacts = units
        .all(battle)
        .filter((unit) => unit.lifecycle === "PRESENT" && isSpatiallyPresent(unit))
        .filter(hasHitbox)
        .map((unit) => ({
            target: units.ref(unit),
            fraction: intersection.sweep(
                shape,
                from,
                to,
                unit.definition.hitbox.shape,
                unit.position,
            ),
        }))
        .filter((contact): contact is Contact => contact.fraction !== null);

    return sort(
        contacts,
        (left, right) => left.fraction - right.fraction || left.target.id - right.target.id,
    );
}
