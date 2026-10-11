import type { Id, Instance, State } from "./effect.js";

const emptyState: State = { instances: [], nextId: 0 };

export function empty(): State {
    return emptyState;
}

export function append(state: State, instance: Instance): State {
    const nextId = instance.id + 1;

    if (!Number.isSafeInteger(nextId)) {
        throw new RangeError("effect identity overflow");
    }

    return {
        instances: [...state.instances, instance],
        nextId,
    };
}

export function replace(state: State, instance: Instance): State {
    const instances = state.instances.map((current) =>
        current.id === instance.id ? instance : current,
    );

    return { ...state, instances };
}

export function remove(state: State, id: Id): State {
    return {
        ...state,
        instances: state.instances.filter((instance) => instance.id !== id),
    };
}
