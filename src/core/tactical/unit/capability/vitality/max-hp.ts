import { resolveMaxHp, type Definition, type State } from "./capability.js";

export function preserveHpRatio(definition: Definition, previous: State, updated: State): State {
    if (previous === updated || previous.maxHp === updated.maxHp) {
        return updated;
    }

    const previousMaxHp = resolveMaxHp(definition, previous);
    const updatedMaxHp = resolveMaxHp(definition, updated);

    if (previousMaxHp === updatedMaxHp || updated.hp <= 0) {
        return updated;
    }

    const hp = Math.min(updatedMaxHp, (updated.hp / previousMaxHp) * updatedMaxHp);

    if (hp === updated.hp) {
        return updated;
    }

    return { ...updated, hp };
}
