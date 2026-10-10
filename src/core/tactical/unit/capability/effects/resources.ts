import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { Binding } from "./binding.js";
import type { EffectValue } from "./effect.js";
import type { EffectDefinitionRef } from "./definition.js";

export interface EffectBindings {
    get(instance: EffectValue): readonly Binding[];
}

export class EffectBindingResources implements EffectBindings {
    readonly #bindings = new Map<string, readonly Binding[]>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(ref: EffectDefinitionRef<S>, bindings: readonly Binding[]): void {
        this.#registration.assertWritable();

        if (this.#bindings.has(ref.id)) {
            throw new TypeError(`duplicate effect bindings ${ref.id}`);
        }

        this.#bindings.set(ref.id, bindings);
    }

    get(instance: EffectValue): readonly Binding[] {
        this.#registration.assertUsable();
        const bindings = this.#bindings.get(instance.definitionRef.id);

        if (bindings === undefined) {
            throw new TypeError(`unregistered effect bindings ${instance.definitionRef.id}`);
        }

        return bindings;
    }
}
