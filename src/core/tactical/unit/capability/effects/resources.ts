import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { EffectBinding } from "./binding.js";
import type { EffectInstanceValue } from "./instance.js";
import type { EffectProgramRef } from "./program.js";

export interface EffectBindings {
    get(instance: EffectInstanceValue): readonly EffectBinding[];
}

export class EffectBindingResources implements EffectBindings {
    readonly #bindings = new Map<string, readonly EffectBinding[]>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(ref: EffectProgramRef<S>, bindings: readonly EffectBinding[]): void {
        this.#registration.assertWritable();

        if (this.#bindings.has(ref.id)) {
            throw new TypeError(`duplicate effect bindings ${ref.id}`);
        }

        const owned = Object.freeze(
            bindings.map(({ install, update, setParticipation, remove }) =>
                Object.freeze({ install, update, setParticipation, remove }),
            ),
        );
        this.#bindings.set(ref.id, owned);
    }

    get(instance: EffectInstanceValue): readonly EffectBinding[] {
        this.#registration.assertUsable();
        const bindings = this.#bindings.get(instance.programRef.id);

        if (bindings === undefined) {
            throw new TypeError(`unregistered effect bindings ${instance.programRef.id}`);
        }

        return bindings;
    }
}
