import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { Binding } from "./binding.js";
import type { EffectInstanceValue } from "./instance.js";
import type { EffectProgramRef } from "./program.js";

export interface EffectBindings {
    get(instance: EffectInstanceValue): readonly Binding[];
}

export class EffectBindingResources implements EffectBindings {
    readonly #bindings = new Map<string, readonly Binding[]>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(ref: EffectProgramRef<S>, bindings: readonly Binding[]): void {
        this.#registration.assertWritable();

        if (this.#bindings.has(ref.id)) {
            throw new TypeError(`duplicate effect bindings ${ref.id}`);
        }

        this.#bindings.set(ref.id, bindings);
    }

    get(instance: EffectInstanceValue): readonly Binding[] {
        this.#registration.assertUsable();
        const bindings = this.#bindings.get(instance.programRef.id);

        if (bindings === undefined) {
            throw new TypeError(`unregistered effect bindings ${instance.programRef.id}`);
        }

        return bindings;
    }
}
