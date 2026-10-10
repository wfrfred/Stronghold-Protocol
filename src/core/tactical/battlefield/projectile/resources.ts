import { ResourceRegistration } from "../../../common/resource-registration.js";
import type { ProjectileProgram, ProjectileProgramRef } from "./program.js";
import type { ProjectileInstance } from "./state.js";

export class ProjectileResources {
    readonly #programs = new Map<string, ProjectileProgram<object>>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(program: ProjectileProgram<S>): ProjectileProgram<S> {
        this.#registration.assertWritable();
        const existing = this.#programs.get(program.ref.id);

        if (existing !== undefined) {
            if (existing !== (program as unknown)) {
                throw new TypeError(`duplicate projectile program ${program.ref.id}`);
            }

            return existing as unknown as ProjectileProgram<S>;
        }

        this.#programs.set(program.ref.id, program as unknown as ProjectileProgram<object>);

        return program;
    }

    get<S extends object>(ref: ProjectileProgramRef<S>): ProjectileProgram<S> {
        this.#registration.assertUsable();
        const program = this.#programs.get(ref.id);

        if (program?.ref !== (ref as unknown)) {
            throw new TypeError(`unregistered projectile program ${ref.id}`);
        }

        return program as unknown as ProjectileProgram<S>;
    }

    withProgram<R>(
        instance: ProjectileInstance,
        visitor: <S extends object>(
            instance: ProjectileInstance<S>,
            program: ProjectileProgram<S>,
        ) => R,
    ): R {
        const ref = instance.programRef as ProjectileProgramRef<object>;

        return visitor(instance, this.get(ref));
    }
}
