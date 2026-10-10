import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { EffectProgram, EffectProgramRef } from "./program.js";
import { createEffectInstance, restoreEffectInstance } from "./internal/instance.js";
import type {
    EffectInstance,
    EffectInstanceMetadata,
    EffectInstanceValue,
    EffectSnapshot,
} from "./instance.js";

export class EffectResources {
    readonly #programs = new Map<string, EffectProgram<object>>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(program: EffectProgram<S>): EffectProgram<S> {
        this.#registration.assertWritable();
        const { ref } = program;
        const existing = this.#programs.get(ref.id);

        if (existing !== undefined) {
            if (!Object.is(existing, program)) {
                throw new TypeError(`duplicate effect program ${ref.id}`);
            }

            return existing as unknown as EffectProgram<S>;
        }

        this.#programs.set(ref.id, program as unknown as EffectProgram<object>);

        return program;
    }

    get<S extends object>(ref: EffectProgramRef<S>): EffectProgram<S> {
        this.#registration.assertUsable();
        const program = this.#programs.get(ref.id);

        if (!Object.is(program?.ref, ref)) {
            throw new TypeError(`unregistered effect program ${ref.id}`);
        }

        return program as unknown as EffectProgram<S>;
    }

    create<S extends object>(
        ref: EffectProgramRef<S>,
        metadata: EffectInstanceMetadata,
        initialState?: NoInfer<S>,
    ): EffectInstance<S> {
        const program = this.get(ref);

        return createEffectInstance(program, metadata, initialState ?? program.initialize());
    }

    restore<S extends object>(
        ref: EffectProgramRef<S>,
        snapshot: EffectSnapshot<NoInfer<S>>,
    ): EffectInstance<S> {
        return restoreEffectInstance(this.get(ref), snapshot);
    }

    typedState<S extends object>(
        instance: EffectInstanceValue,
        ref: EffectProgramRef<S>,
    ): S | undefined {
        return this.typedInstance(instance, ref)?.state;
    }

    typedInstance<S extends object>(
        instance: EffectInstanceValue,
        ref: EffectProgramRef<S>,
    ): EffectInstance<S> | undefined {
        this.get(ref);

        return instance.programRef === ref ? (instance as EffectInstance<S>) : undefined;
    }

    update<S extends object>(instance: EffectInstance<S>, state: NoInfer<S>): EffectInstance<S> {
        this.#registration.assertUsable();

        if (state === instance.state) {
            return instance;
        }

        return { ...instance, state };
    }

    #instanceProgram(instance: EffectInstanceValue): EffectProgram<object> {
        this.#registration.assertUsable();
        const program = this.#programs.get(instance.programRef.id);

        if (program?.ref !== instance.programRef) {
            throw new TypeError(`unregistered effect program ${instance.programRef.id}`);
        }

        return program;
    }

    withProgram<R>(
        instance: EffectInstanceValue,
        visitor: <S extends object>(instance: EffectInstance<S>, program: EffectProgram<S>) => R,
    ): R {
        return visitor(instance as EffectInstance<object>, this.#instanceProgram(instance));
    }
}
