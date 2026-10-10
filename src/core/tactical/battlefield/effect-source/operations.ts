import { getMechanism, updateMechanism, type BattleState } from "../../battle/execution/context.js";
import type { MechanismId } from "../mechanism.js";
import type { EffectSourceProgramRef } from "./program.js";
import type { EffectSourceResources } from "./resources.js";
import { hasEffectSource, type TypedEffectSourceMechanism } from "./state.js";

export interface EffectSourceOperations {
    get<S extends object>(
        id: MechanismId,
        ref: EffectSourceProgramRef<S>,
    ): TypedEffectSourceMechanism<S> | undefined;
    update<S extends object>(
        id: MechanismId,
        ref: EffectSourceProgramRef<S>,
        transition: (current: NoInfer<S>) => NoInfer<S>,
    ): void;
    tryConsume<S extends object>(
        id: MechanismId,
        ref: EffectSourceProgramRef<S>,
        transition: (current: NoInfer<S>) => NoInfer<S> | undefined,
    ): boolean;
}

export function createEffectSourceOperations(
    getWork: () => BattleState,
    resources: { readonly effectSources: EffectSourceResources },
): EffectSourceOperations {
    const get = <S extends object>(id: MechanismId, ref: EffectSourceProgramRef<S>) => {
        const source = getMechanism(getWork(), id);

        return source !== undefined && hasEffectSource(source)
            ? resources.effectSources.typedSource(source, ref)
            : undefined;
    };

    return {
        get,
        update: (id, ref, transition) => {
            const source = get(id, ref);

            if (source !== undefined) {
                updateMechanism(
                    getWork(),
                    resources.effectSources.update(
                        source,
                        ref,
                        transition(source.effectSource.state),
                    ),
                );
            }
        },
        tryConsume: (id, ref, transition) => {
            const source = get(id, ref);

            if (source === undefined || source.effectSource.finished || !source.active) {
                return false;
            }

            const next = transition(source.effectSource.state);

            if (next === undefined) {
                return false;
            }

            updateMechanism(getWork(), resources.effectSources.update(source, ref, next));

            return true;
        },
    };
}
