import type { Unit } from "../unit.js";
import type { State, Value } from "./effect.js";

const emptyState: State = { instances: [], nextId: 0 };

export function empty(): State {
    return emptyState;
}

export function append(unit: Unit, instance: Value): Unit {
    const nextId = instance.id + 1;

    if (!Number.isSafeInteger(nextId)) {
        throw new RangeError("effect identity overflow");
    }

    return {
        ...unit,
        effects: { instances: [...unit.effects.instances, instance], nextId },
    };
}

export function replace(unit: Unit, instance: Value): Unit {
    const instances = unit.effects.instances.map((current) =>
        current.id === instance.id ? instance : current,
    );

    return { ...unit, effects: { ...unit.effects, instances } };
}

export function remove(unit: Unit, id: number): Unit {
    return {
        ...unit,
        effects: {
            ...unit.effects,
            instances: unit.effects.instances.filter((instance) => instance.id !== id),
        },
    };
}
