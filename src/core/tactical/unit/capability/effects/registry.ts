import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { EffectDefinition } from "./definition.js";
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
        const existing = this.#definitions.get(definition.id);

        if (existing !== undefined) {
            if (!Object.is(existing, definition)) {
                throw new TypeError(`duplicate effect definition ${definition.id}`);
            }

            return existing as unknown as EffectDefinition<S>;
        }

        this.#definitions.set(definition.id, definition as unknown as EffectDefinition<object>);

        return definition;
    }

    get<S extends object>(definition: EffectDefinition<S>): EffectDefinition<S> {
        this.#registration.assertUsable();

        if (!Object.is(this.#definitions.get(definition.id), definition)) {
            throw new TypeError(`unregistered effect definition ${definition.id}`);
        }

        return definition;
    }

    create<S extends object>(
        definition: EffectDefinition<S>,
        metadata: EffectMetadata,
        initialState?: NoInfer<S>,
    ): Effect<S> {
        this.get(definition);

        return createEffect(definition, metadata, initialState ?? definition.initialize());
    }

    restore<S extends object>(
        definition: EffectDefinition<S>,
        snapshot: EffectSnapshot<NoInfer<S>>,
    ): Effect<S> {
        return restoreEffect(this.get(definition), snapshot);
    }

    typedState<S extends object>(
        instance: EffectValue,
        definition: EffectDefinition<S>,
    ): S | undefined {
        return this.typedEffect(instance, definition)?.state;
    }

    typedEffect<S extends object>(
        instance: EffectValue,
        definition: EffectDefinition<S>,
    ): Effect<S> | undefined {
        this.get(definition);

        return instance.definition === definition ? (instance as Effect<S>) : undefined;
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
        const definition = this.#definitions.get(instance.definition.id);

        if (definition !== instance.definition) {
            throw new TypeError(`unregistered effect definition ${instance.definition.id}`);
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
