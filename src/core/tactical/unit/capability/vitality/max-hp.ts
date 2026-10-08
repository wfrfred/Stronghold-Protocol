import { widenUnit, type StableUnit, type Unit } from "../../unit.js";
import { hasVitality, resolveVitalityMaxHp } from "./capability.js";

export function preserveHpRatio<U extends Unit>(
    previous: U | StableUnit<U>,
    input: U | StableUnit<U>,
): StableUnit<U> {
    const updated = widenUnit<U>(input);

    if (
        previous === updated ||
        !hasVitality(previous) ||
        !hasVitality(updated) ||
        previous.vitality.maxHp === updated.vitality.maxHp
    ) {
        return updated;
    }

    const previousMaxHp = resolveVitalityMaxHp(previous.definition.vitality, previous.vitality);
    const updatedMaxHp = resolveVitalityMaxHp(updated.definition.vitality, updated.vitality);

    if (previousMaxHp === updatedMaxHp || updated.vitality.hp <= 0) {
        return updated;
    }

    const hp = Math.min(updatedMaxHp, (updated.vitality.hp / previousMaxHp) * updatedMaxHp);

    if (hp === updated.vitality.hp) {
        return updated;
    }

    return {
        ...updated,
        vitality: {
            ...updated.vitality,
            hp,
        },
    };
}
