import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { CompiledEffectContribution } from "./contribution-bindings.js";
import type { EffectInstanceValue } from "./instance.js";
import type { EffectProgramRef } from "./program.js";

export interface EffectContributionBindings {
    get(instance: EffectInstanceValue): readonly CompiledEffectContribution[];
}

export class EffectBindingResources implements EffectContributionBindings {
    readonly #contributions = new Map<string, readonly CompiledEffectContribution[]>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(
        ref: EffectProgramRef<S>,
        bindings: readonly CompiledEffectContribution[],
    ): void {
        this.#registration.assertWritable();

        if (this.#contributions.has(ref.id)) {
            throw new TypeError(`duplicate effect bindings ${ref.id}`);
        }

        const owned = Object.freeze(
            bindings.map(({ install, update, setParticipation, remove }) =>
                Object.freeze({ install, update, setParticipation, remove }),
            ),
        );
        this.#contributions.set(ref.id, owned);
    }

    get(instance: EffectInstanceValue): readonly CompiledEffectContribution[] {
        this.#registration.assertUsable();
        const bindings = this.#contributions.get(instance.programRef.id);

        if (bindings === undefined) {
            throw new TypeError(`unregistered effect bindings ${instance.programRef.id}`);
        }

        return bindings;
    }
}
