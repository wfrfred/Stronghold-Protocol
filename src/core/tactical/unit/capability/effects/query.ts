import { getUnit, type BattleState } from "../../../battle/execution/context.js";
import { hasEffects } from "./capability.js";
import type { EffectRef, EffectValue } from "./effect.js";
import type { EffectView } from "./contract.js";

const indexes = new WeakMap<readonly EffectValue[], ReadonlyMap<number, EffectValue>>();

export function isParticipatingEffect(instance: EffectValue): boolean {
    return instance.started && instance.participating && !instance.finished;
}

export function getEffect(state: BattleState, address: EffectRef): EffectValue | undefined {
    const unit = getUnit(state, address.unitId);

    if (unit === undefined || !hasEffects(unit)) {
        return undefined;
    }

    const instances = unit.effects.instances;
    let index = indexes.get(instances);

    if (index === undefined) {
        index = new Map(instances.map((instance) => [instance.id, instance]));
        indexes.set(instances, index);
    }

    return index.get(address.effectId);
}

export function effectView(readState: () => BattleState): EffectView {
    return {
        getUnit: (id) => getUnit(readState(), id),
        getEffect: (address) => getEffect(readState(), address),
        participating: (id) => {
            const unit = getUnit(readState(), id);

            return unit !== undefined && hasEffects(unit)
                ? unit.effects.instances.filter(isParticipatingEffect)
                : [];
        },
    };
}
