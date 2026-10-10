import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { Binding } from "./binding.js";
import type { EffectValue } from "./effect.js";
import type { EffectDefinition } from "./definition.js";

export interface EffectBindings {
    get(instance: EffectValue): readonly Binding[];
}

export class EffectBindingResources implements EffectBindings {
    readonly #bindings = new Map<string, readonly Binding[]>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(
        definition: EffectDefinition<S>,
        bindings: readonly Binding[],
    ): void {
        this.#registration.assertWritable();

        if (this.#bindings.has(definition.id)) {
            throw new TypeError(`duplicate effect bindings ${definition.id}`);
        }

        this.#bindings.set(definition.id, bindings);
    }

    get(instance: EffectValue): readonly Binding[] {
        this.#registration.assertUsable();
        const bindings = this.#bindings.get(instance.definition.id);

        if (bindings === undefined) {
            throw new TypeError(`unregistered effect bindings ${instance.definition.id}`);
        }

        return bindings;
    }
}
