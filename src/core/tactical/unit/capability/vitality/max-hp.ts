import { resolveVitalityMaxHp, type VitalityDefinition, type VitalityState } from "./capability.js";

export function preserveHpRatio(
    definition: VitalityDefinition,
    previous: VitalityState,
    updated: VitalityState,
): VitalityState {
    if (previous === updated || previous.maxHp === updated.maxHp) {
        return updated;
    }

    const previousMaxHp = resolveVitalityMaxHp(definition, previous);
    const updatedMaxHp = resolveVitalityMaxHp(definition, updated);

    if (previousMaxHp === updatedMaxHp || updated.hp <= 0) {
        return updated;
    }

    const hp = Math.min(updatedMaxHp, (updated.hp / previousMaxHp) * updatedMaxHp);

    if (hp === updated.hp) {
        return updated;
    }

    return { ...updated, hp };
}
