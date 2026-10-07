import { ownDataRecord } from "../../../common/immutable-data.js";
import { ResourceRegistration } from "../../../common/resource-registration.js";
import type { ProjectileProgram, ProjectileProgramRef } from "./program.js";
import type { ProjectileInstance } from "./state.js";

interface RegisteredProjectileProgram {
    readonly source: object;
    readonly program: ProjectileProgram<object>;
}

export class ProjectileResources {
    readonly #programs = new Map<string, RegisteredProjectileProgram>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(program: ProjectileProgram<S>): ProjectileProgram<S> {
        this.#registration.assertWritable();
        const existing = this.#programs.get(program.ref.id);

        if (existing !== undefined) {
            if (existing.source !== program && existing.program !== (program as unknown)) {
                throw new TypeError(`duplicate projectile program ${program.ref.id}`);
            }

            return existing.program as unknown as ProjectileProgram<S>;
        }
        if (!Object.isFrozen(program.ref)) {
            throw new TypeError("projectile program references must be immutable");
        }

        const owned = Object.freeze({
            ref: program.ref,
            initialize: program.initialize,
            ownState: program.ownState,
            acceptsContact: program.acceptsContact,
            ...(program.contact === undefined ? {} : { contact: program.contact }),
            ...(program.stop === undefined ? {} : { stop: program.stop }),
        });
        this.#programs.set(program.ref.id, {
            source: program,
            program: owned as unknown as ProjectileProgram<object>,
        });

        return owned;
    }

    get<S extends object>(ref: ProjectileProgramRef<S>): ProjectileProgram<S> {
        this.#registration.assertUsable();
        const program = this.#programs.get(ref.id)?.program;

        if (program?.ref !== (ref as unknown)) {
            throw new TypeError(`unregistered projectile program ${ref.id}`);
        }

        return program as unknown as ProjectileProgram<S>;
    }

    ownState<S extends object>(ref: ProjectileProgramRef<S>, value: unknown): S {
        return ownDataRecord(this.get(ref).ownState(value), "projectile state");
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
