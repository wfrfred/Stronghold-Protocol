import { copyEffectInstance, type EffectInstanceValue } from "./instance.js";
import type { Unit } from "../../unit.js";

export interface EffectsState {
    readonly instances: readonly EffectInstanceValue[];
}

export interface Effects {
    readonly effects: EffectsState;
}

const ownedArrays = new WeakSet<readonly EffectInstanceValue[]>();

export function hasEffects<U extends Unit>(unit: U): unit is U & Effects {
    return "effects" in unit;
}

export function createEffectsState(instances: readonly EffectInstanceValue[] = []): EffectsState {
    if (ownedArrays.has(instances)) {
        return Object.freeze({ instances });
    }

    const ids = new Set<number>();
    const owned = instances.map((instance) => {
        if (ids.has(instance.id)) {
            throw new TypeError(`duplicate effect instance ${instance.id}`);
        }

        ids.add(instance.id);

        return copyEffectInstance(instance);
    });

    Object.freeze(owned);
    ownedArrays.add(owned);

    return Object.freeze({ instances: owned });
}

export function copyEffectsState(state: EffectsState): EffectsState {
    return createEffectsState(state.instances);
}
