declare const effectStateType: unique symbol;

export interface EffectProgramRef<S extends object> {
    readonly id: string;
    readonly [effectStateType]: (state: S) => S;
}

export interface EffectProgram<S extends object> {
    readonly ref: EffectProgramRef<S>;
    readonly initialize: () => S;
    readonly ownState: (value: S) => S;
}

export function createEffectProgram<S extends object>(definition: {
    readonly id: string;
    readonly initialize: () => S;
    readonly ownState: (value: NoInfer<S>) => NoInfer<S>;
}): EffectProgram<S> {
    if (definition.id.length === 0) {
        throw new TypeError("effect program identity must be nonempty");
    }

    return Object.freeze({
        ref: Object.freeze({ id: definition.id }) as EffectProgramRef<S>,
        initialize: definition.initialize,
        ownState: definition.ownState,
    });
}
