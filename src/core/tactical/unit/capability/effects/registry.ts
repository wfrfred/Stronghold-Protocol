import type { EffectProgram, EffectProgramRef } from "./program.js";
import {
    copyEffectInstance,
    ownEffectInstance,
    ownEffectState,
    ownRestoredEffectInstance,
    ownUpdatedEffectInstance,
    readEffectSnapshot,
    type EffectInstance,
    type EffectInstanceMetadata,
    type EffectInstanceValue,
} from "./instance.js";

export class EffectResources {
    readonly #programs = new Map<string, EffectProgram<object>>();

    register<S extends object>(program: EffectProgram<S>): EffectProgram<S> {
        const existing = this.#programs.get(program.ref.id);

        if (existing !== undefined && !Object.is(existing.ref, program.ref)) {
            throw new TypeError(`duplicate effect program ${program.ref.id}`);
        }

        this.#programs.set(program.ref.id, program as unknown as EffectProgram<object>);

        return program;
    }

    get<S extends object>(ref: EffectProgramRef<S>): EffectProgram<S> {
        const program = this.#programs.get(ref.id);

        if (!Object.is(program?.ref, ref)) {
            throw new TypeError(`unregistered effect program ${ref.id}`);
        }

        return program as unknown as EffectProgram<S>;
    }

    create<S extends object>(
        ref: EffectProgramRef<S>,
        metadata: EffectInstanceMetadata,
    ): EffectInstance<S> {
        const program = this.get(ref);

        return ownEffectInstance(program, metadata, program.initialize(), null);
    }

    restore(value: unknown): EffectInstanceValue {
        const { instance, programId } = readEffectSnapshot(value);
        const program = this.#programs.get(programId);

        if (program === undefined) {
            throw new TypeError(`unregistered effect program ${programId}`);
        }

        return ownRestoredEffectInstance(program, instance);
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
        copyEffectInstance(instance);

        return instance.programRef === ref ? (instance as EffectInstance<S>) : undefined;
    }

    update<S extends object>(
        instance: EffectInstanceValue,
        ref: EffectProgramRef<S>,
        state: NoInfer<S>,
    ): EffectInstance<S> {
        const program = this.get(ref);

        if (this.typedState(instance, ref) === undefined) {
            throw new TypeError("effect state update must use its matching program");
        }
        if (state === instance.state) {
            return instance as EffectInstance<S>;
        }

        const ownedState = ownEffectState(program, state);

        if (ownedState === instance.state) {
            return instance as EffectInstance<S>;
        }

        return ownUpdatedEffectInstance(instance, ref, ownedState);
    }

    withProgram<R>(
        instance: EffectInstanceValue,
        visitor: <S extends object>(instance: EffectInstance<S>, program: EffectProgram<S>) => R,
    ): R {
        copyEffectInstance(instance);
        const program = this.#programs.get(instance.programRef.id);

        if (program?.ref !== instance.programRef) {
            throw new TypeError(`unregistered effect program ${instance.programRef.id}`);
        }

        return visitor(instance as EffectInstance<object>, program);
    }
}
