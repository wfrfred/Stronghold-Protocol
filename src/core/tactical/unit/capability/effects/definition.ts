export interface EffectDefinition<in out S extends object> {
    readonly id: string;
    readonly initialize: () => S;
}

export function createEffectDefinition<S extends object>(definition: {
    readonly id: string;
    readonly initialize: () => S;
}): EffectDefinition<S> {
    if (definition.id.length === 0) {
        throw new TypeError("effect definition identity must be nonempty");
    }

    return Object.freeze({
        id: definition.id,
        initialize: definition.initialize,
    });
}
