import { getUnit, type BattleState } from "../../../battle/execution/context.js";
import { hasEffects } from "./capability.js";
import type { EffectRef, EffectInstanceValue } from "./instance.js";
import type { EffectView } from "./contract.js";

const indexes = new WeakMap<
    readonly EffectInstanceValue[],
    ReadonlyMap<number, EffectInstanceValue>
>();

export function isParticipatingEffect(instance: EffectInstanceValue): boolean {
    return instance.started && instance.participating && !instance.finished;
}

export function getEffect(work: BattleState, address: EffectRef): EffectInstanceValue | undefined {
    const unit = getUnit(work, address.unitId);

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

export function effectView(work: () => BattleState): EffectView {
    return {
        getUnit: (id) => getUnit(work(), id),
        getEffect: (address) => getEffect(work(), address),
        participating: (id) => {
            const unit = getUnit(work(), id);

            return unit !== undefined && hasEffects(unit)
                ? unit.effects.instances.filter(isParticipatingEffect)
                : [];
        },
    };
}
