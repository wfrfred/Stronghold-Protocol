import type { Unit, Id } from "../../unit/unit.js";
import {
    hasLocomotion,
    removeRule,
    setRule,
    type Rule,
} from "../../unit/capability/locomotion/capability.js";
import type { BlockingRelation } from "./relations.js";

const blocked: Rule = { id: "@blocking/blocked", allows: () => false };

export function synchronize<U extends Unit>(
    units: ReadonlyMap<Id, U>,
    relations: readonly BlockingRelation[],
): ReadonlyMap<Id, U> {
    const blockedIds = new Set(relations.map((relation) => relation.blockedUnitId));
    let changed: Map<Id, U> | undefined;

    for (const unit of units.values()) {
        if (!hasLocomotion(unit)) {
            continue;
        }

        const locomotion = blockedIds.has(unit.id)
            ? setRule(unit.locomotion, blocked)
            : removeRule(unit.locomotion, blocked.id);

        if (locomotion !== unit.locomotion) {
            changed ??= new Map(units);
            changed.set(unit.id, { ...unit, locomotion });
        }
    }

    return changed ?? units;
}
