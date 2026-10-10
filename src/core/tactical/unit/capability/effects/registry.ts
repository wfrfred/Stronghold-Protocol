import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { EffectDefinition, EffectDefinitionRef } from "./definition.js";
import { createEffect, restoreEffect } from "./internal/effect.js";
import type { Effect, EffectMetadata, EffectValue, EffectSnapshot } from "./effect.js";

export class EffectResources {
    readonly #definitions = new Map<string, EffectDefinition<object>>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(definition: EffectDefinition<S>): EffectDefinition<S> {
        this.#registration.assertWritable();
        const { ref } = definition;
        const existing = this.#definitions.get(ref.id);

        if (existing !== undefined) {
            if (!Object.is(existing, definition)) {
                throw new TypeError(`duplicate effect definition ${ref.id}`);
            }

            return existing as unknown as EffectDefinition<S>;
        }

        this.#definitions.set(ref.id, definition as unknown as EffectDefinition<object>);

        return definition;
    }

    get<S extends object>(ref: EffectDefinitionRef<S>): EffectDefinition<S> {
        this.#registration.assertUsable();
        const definition = this.#definitions.get(ref.id);

        if (!Object.is(definition?.ref, ref)) {
            throw new TypeError(`unregistered effect definition ${ref.id}`);
        }

        return definition as unknown as EffectDefinition<S>;
    }

    create<S extends object>(
        ref: EffectDefinitionRef<S>,
        metadata: EffectMetadata,
        initialState?: NoInfer<S>,
    ): Effect<S> {
        const definition = this.get(ref);

        return createEffect(definition, metadata, initialState ?? definition.initialize());
    }

    restore<S extends object>(
        ref: EffectDefinitionRef<S>,
        snapshot: EffectSnapshot<NoInfer<S>>,
    ): Effect<S> {
        return restoreEffect(this.get(ref), snapshot);
    }

    typedState<S extends object>(
        instance: EffectValue,
        ref: EffectDefinitionRef<S>,
    ): S | undefined {
        return this.typedEffect(instance, ref)?.state;
    }

    typedEffect<S extends object>(
        instance: EffectValue,
        ref: EffectDefinitionRef<S>,
    ): Effect<S> | undefined {
        this.get(ref);

        return instance.definitionRef === ref ? (instance as Effect<S>) : undefined;
    }

    update<S extends object>(instance: Effect<S>, state: NoInfer<S>): Effect<S> {
        this.#registration.assertUsable();

        if (state === instance.state) {
            return instance;
        }

        return { ...instance, state };
    }

    #effectDefinition(instance: EffectValue): EffectDefinition<object> {
        this.#registration.assertUsable();
        const definition = this.#definitions.get(instance.definitionRef.id);

        if (definition?.ref !== instance.definitionRef) {
            throw new TypeError(`unregistered effect definition ${instance.definitionRef.id}`);
        }

        return definition;
    }

    withDefinition<R>(
        instance: EffectValue,
        visitor: <S extends object>(instance: Effect<S>, definition: EffectDefinition<S>) => R,
    ): R {
        return visitor(instance as Effect<object>, this.#effectDefinition(instance));
    }
}
