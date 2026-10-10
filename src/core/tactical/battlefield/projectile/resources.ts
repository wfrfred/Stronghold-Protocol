import { ResourceRegistration } from "../../../common/resource-registration.js";
import type { ProjectileDefinition, ProjectileDefinitionRef } from "./definition.js";
import type { Projectile } from "./projectile.js";

export class ProjectileResources {
    readonly #definitions = new Map<string, ProjectileDefinition<object>>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(definition: ProjectileDefinition<S>): ProjectileDefinition<S> {
        this.#registration.assertWritable();
        const existing = this.#definitions.get(definition.ref.id);

        if (existing !== undefined) {
            if (existing !== (definition as unknown)) {
                throw new TypeError(`duplicate projectile definition ${definition.ref.id}`);
            }

            return existing as unknown as ProjectileDefinition<S>;
        }

        this.#definitions.set(
            definition.ref.id,
            definition as unknown as ProjectileDefinition<object>,
        );

        return definition;
    }

    get<S extends object>(ref: ProjectileDefinitionRef<S>): ProjectileDefinition<S> {
        this.#registration.assertUsable();
        const definition = this.#definitions.get(ref.id);

        if (definition?.ref !== (ref as unknown)) {
            throw new TypeError(`unregistered projectile definition ${ref.id}`);
        }

        return definition as unknown as ProjectileDefinition<S>;
    }

    withDefinition<R>(
        instance: Projectile,
        visitor: <S extends object>(
            instance: Projectile<S>,
            definition: ProjectileDefinition<S>,
        ) => R,
    ): R {
        const ref = instance.definitionRef as ProjectileDefinitionRef<object>;

        return visitor(instance, this.get(ref));
    }
}
