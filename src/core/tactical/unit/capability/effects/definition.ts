declare const effectStateType: unique symbol;

export interface EffectDefinitionRef<S extends object> {
    readonly id: string;
    readonly [effectStateType]: (state: S) => S;
}

export interface EffectDefinition<S extends object> {
    readonly ref: EffectDefinitionRef<S>;
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
        ref: Object.freeze({ id: definition.id }) as EffectDefinitionRef<S>,
        initialize: definition.initialize,
    });
}
