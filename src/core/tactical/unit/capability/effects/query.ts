import { getCombatUnit, type CombatWork } from "../../../battle/execution/work.js";
import { hasEffects } from "./capability.js";
import type { EffectAddress, EffectInstanceValue } from "./instance.js";
import type { EffectFacts } from "./contract.js";

export function getEffect(
    work: CombatWork,
    address: EffectAddress,
): EffectInstanceValue | undefined {
    const unit = getCombatUnit(work, address.unitId);

    return unit !== undefined && hasEffects(unit)
        ? unit.effects.instances.find((instance) => instance.id === address.instanceId)
        : undefined;
}

export function effectFacts(work: () => CombatWork): EffectFacts {
    return {
        getUnit: (id) => getCombatUnit(work(), id),
        getEffect: (address) => getEffect(work(), address),
        participating: (id) => {
            const unit = getCombatUnit(work(), id);

            return unit !== undefined && hasEffects(unit)
                ? unit.effects.instances.filter(
                      (instance) => instance.participating && !instance.finished,
                  )
                : [];
        },
    };
}
