import { ownDataRecord } from "../../../common/immutable-data.js";
import { ResourceRegistration } from "../../../common/resource-registration.js";
import type { EffectTransitionResources } from "../../unit/capability/effects/contract.js";
import type { UnitId } from "../../unit/unit.js";
import type { EffectSourceProgram, EffectSourceProgramRef } from "./program.js";
import { updateEffectSourceReceiverView } from "./internal/receivers.js";
import {
    copyEffectSourceState,
    type EffectSourceMechanism,
    type EffectSourceStateValue,
    type TypedEffectSourceMechanism,
} from "./state.js";

interface RegisteredSourceProgram {
    readonly source: object;
    readonly program: EffectSourceProgram<object>;
}

export interface EffectSourceServices extends EffectTransitionResources {
    readonly effectSources: EffectSourceResources;
}

export class EffectSourceResources {
    readonly #programs = new Map<string, RegisteredSourceProgram>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(program: EffectSourceProgram<S>): EffectSourceProgram<S> {
        this.#registration.assertWritable();
        const existing = this.#programs.get(program.ref.id);

        if (existing !== undefined) {
            if (existing.source !== program && existing.program !== (program as unknown)) {
                throw new TypeError(`duplicate effect source program ${program.ref.id}`);
            }

            return existing.program as unknown as EffectSourceProgram<S>;
        }
        if (!Object.isFrozen(program.ref)) {
            throw new TypeError("effect source program references must be immutable");
        }

        const owned = Object.freeze({
            ref: program.ref,
            initialize: program.initialize,
            ownState: program.ownState,
            selectInitial: program.selectInitial,
            install: program.install,
            ...(program.acceptsRegistration === undefined
                ? {}
                : { acceptsRegistration: program.acceptsRegistration }),
            ...(program.selectCurrent === undefined
                ? {}
                : { selectCurrent: program.selectCurrent }),
            ...(program.shouldReinstall === undefined
                ? {}
                : { shouldReinstall: program.shouldReinstall }),
            ...(program.keepOnLeave === undefined ? {} : { keepOnLeave: program.keepOnLeave }),
            ...(program.keepOnFinish === undefined ? {} : { keepOnFinish: program.keepOnFinish }),
            ...(program.followsParticipation === undefined
                ? {}
                : { followsParticipation: program.followsParticipation }),
            ...(program.shouldFinish === undefined ? {} : { shouldFinish: program.shouldFinish }),
        });

        this.#programs.set(program.ref.id, {
            source: program,
            program: owned as unknown as EffectSourceProgram<object>,
        });

        return owned;
    }

    get<S extends object>(ref: EffectSourceProgramRef<S>): EffectSourceProgram<S> {
        this.#registration.assertUsable();
        const program = this.#programs.get(ref.id)?.program;

        if (program?.ref !== (ref as unknown)) {
            throw new TypeError(`unregistered effect source program ${ref.id}`);
        }

        return program as unknown as EffectSourceProgram<S>;
    }

    create<S extends object>(
        ref: EffectSourceProgramRef<S>,
        input: { readonly sourceUnitId: UnitId | null; readonly initialState?: NoInfer<S> },
    ): EffectSourceStateValue {
        const program = this.get(ref);

        return copyEffectSourceState({
            programRef: ref,
            sourceUnitId: input.sourceUnitId,
            state: ownDataRecord(
                program.ownState(input.initialState ?? program.initialize(input.sourceUnitId)),
                "effect source state",
            ),
            receivers: [],
            initialized: false,
            finished: false,
        });
    }

    typedSource<S extends object>(
        source: EffectSourceMechanism,
        ref: EffectSourceProgramRef<S>,
    ): TypedEffectSourceMechanism<S> | undefined {
        this.get(ref);

        return source.effectSource.programRef === ref
            ? (source as TypedEffectSourceMechanism<S>)
            : undefined;
    }

    update<S extends object>(
        source: EffectSourceMechanism,
        ref: EffectSourceProgramRef<S>,
        state: NoInfer<S>,
    ): TypedEffectSourceMechanism<S> {
        const program = this.get(ref);

        if (source.effectSource.programRef !== ref) {
            throw new TypeError("effect source state update must use its matching program");
        }
        if (state === source.effectSource.state) {
            return source as TypedEffectSourceMechanism<S>;
        }

        const next = ownDataRecord(program.ownState(state), "effect source state");

        return {
            ...source,
            effectSource:
                updateEffectSourceReceiverView(source.effectSource, { state: next }) ??
                copyEffectSourceState({ ...source.effectSource, state: next }),
        } as TypedEffectSourceMechanism<S>;
    }

    withProgram<R>(
        source: EffectSourceMechanism,
        visitor: <S extends object>(
            source: TypedEffectSourceMechanism<S>,
            program: EffectSourceProgram<S>,
        ) => R,
    ): R {
        const ref = source.effectSource.programRef as EffectSourceProgramRef<object>;

        return visitor(source as TypedEffectSourceMechanism<object>, this.get(ref));
    }
}
