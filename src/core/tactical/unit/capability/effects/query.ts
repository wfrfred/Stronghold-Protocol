import { getCombatUnit, type CombatWork } from "../../../battle/execution/work.js";
import { hasEffects } from "./capability.js";
import type { EffectRef, EffectInstanceValue } from "./instance.js";
import type { EffectView } from "./contract.js";

export function isParticipatingEffect(instance: EffectInstanceValue): boolean {
    return instance.started && instance.participating && !instance.finished;
}

export function getEffect(work: CombatWork, address: EffectRef): EffectInstanceValue | undefined {
    const unit = getCombatUnit(work, address.unitId);

    return unit !== undefined && hasEffects(unit)
        ? unit.effects.instances.find((instance) => instance.id === address.effectId)
        : undefined;
}

export function effectView(work: () => CombatWork): EffectView {
    return {
        getUnit: (id) => getCombatUnit(work(), id),
        getEffect: (address) => getEffect(work(), address),
        participating: (id) => {
            const unit = getCombatUnit(work(), id);

            return unit !== undefined && hasEffects(unit)
                ? unit.effects.instances.filter(isParticipatingEffect)
                : [];
        },
    };
}
