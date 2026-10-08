import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { EffectProgram, EffectProgramRef } from "./program.js";
import {
    copyEffectInstance,
    ownEffectInstance,
    ownEffectState,
    ownRestoredEffectInstance,
    ownUpdatedEffectInstance,
} from "./internal/instance.js";
import type {
    EffectInstance,
    EffectInstanceMetadata,
    EffectInstanceValue,
    EffectSnapshot,
} from "./instance.js";

interface RegisteredEffectProgram {
    readonly source: object;
    readonly program: EffectProgram<object>;
}

export class EffectResources {
    readonly #programs = new Map<string, RegisteredEffectProgram>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(program: EffectProgram<S>): EffectProgram<S> {
        this.#registration.assertWritable();
        const { ref, initialize, ownState } = program;
        const existing = this.#programs.get(ref.id);

        if (existing !== undefined) {
            if (!Object.is(existing.source, program) && !Object.is(existing.program, program)) {
                throw new TypeError(`duplicate effect program ${ref.id}`);
            }

            return existing.program as unknown as EffectProgram<S>;
        }

        const owned = Object.freeze({ ref, initialize, ownState });
        this.#programs.set(ref.id, {
            source: program,
            program: owned as unknown as EffectProgram<object>,
        });

        return owned;
    }

    get<S extends object>(ref: EffectProgramRef<S>): EffectProgram<S> {
        this.#registration.assertUsable();
        const program = this.#programs.get(ref.id)?.program;

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

        return ownEffectInstance(program, metadata, initialState ?? program.initialize());
    }

    restore<S extends object>(
        ref: EffectProgramRef<S>,
        snapshot: EffectSnapshot<NoInfer<S>>,
    ): EffectInstance<S> {
        return ownRestoredEffectInstance(this.get(ref), snapshot);
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
        const program = this.get(instance.programRef);
        const owned = copyEffectInstance(instance);

        if (state === instance.state) {
            return owned;
        }

        const ownedState = ownEffectState(program, state);

        if (ownedState === owned.state) {
            return owned;
        }

        return ownUpdatedEffectInstance(owned, owned.programRef, ownedState);
    }

    #instanceProgram(instance: EffectInstanceValue): EffectProgram<object> {
        this.#registration.assertUsable();
        const program = this.#programs.get(instance.programRef.id)?.program;

        if (program?.ref !== instance.programRef) {
            throw new TypeError(`unregistered effect program ${instance.programRef.id}`);
        }

        return program;
    }

    assertInstance(instance: EffectInstanceValue): void {
        this.#instanceProgram(instance);
    }

    withProgram<R>(
        instance: EffectInstanceValue,
        visitor: <S extends object>(instance: EffectInstance<S>, program: EffectProgram<S>) => R,
    ): R {
        return visitor(instance as EffectInstance<object>, this.#instanceProgram(instance));
    }
}
