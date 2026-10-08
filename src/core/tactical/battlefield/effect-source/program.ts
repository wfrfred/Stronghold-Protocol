import type { Unit, UnitId } from "../../unit/unit.js";
import type { CombatTargetingView } from "../../unit/targeting/query.js";
import type { EffectProgramRef } from "../../unit/capability/effects/program.js";
import type { EffectSourceReceiver, TypedEffectSourceMechanism } from "./state.js";

declare const sourceStateType: unique symbol;

export interface EffectSourceProgramRef<S extends object> {
    readonly id: string;
    readonly [sourceStateType]: (state: S) => S;
}

export interface EffectSourceContext<S extends object> {
    readonly source: TypedEffectSourceMechanism<S>;
    readonly battlefield: CombatTargetingView;
    readonly tick: number;
}

export interface EffectSourceReceiverContext<S extends object> extends EffectSourceContext<S> {
    readonly receiver: Unit;
    readonly binding: EffectSourceReceiver;
}

export interface EffectSourceInstallationInput<S extends object> {
    readonly expiresAtTick: number | null;
    readonly initialState?: S;
}

export type EffectSourceInstallation = <R>(
    install: <S extends object>(
        ref: EffectProgramRef<S>,
        input: EffectSourceInstallationInput<NoInfer<S>>,
    ) => R,
) => R;

export interface EffectSourceProgram<S extends object> {
    readonly ref: EffectSourceProgramRef<S>;
    readonly initialize: (sourceUnitId: UnitId | null) => S;
    readonly ownState: (value: S) => S;
    readonly selectInitial: (context: EffectSourceContext<S>) => readonly UnitId[];
    readonly acceptsRegistration?: (context: EffectSourceReceiverContext<S>) => boolean;
    readonly selectCurrent?: (context: EffectSourceContext<S>) => readonly UnitId[];
    readonly install: (
        context: EffectSourceReceiverContext<S>,
    ) => EffectSourceInstallation | undefined;
    readonly shouldReinstall?: (context: EffectSourceReceiverContext<S>) => boolean;
    readonly keepOnLeave?: (context: EffectSourceReceiverContext<S>) => boolean;
    readonly keepOnFinish?: (context: EffectSourceReceiverContext<S>) => boolean;
    readonly followsSourceActive?: (context: EffectSourceReceiverContext<S>) => boolean;
    readonly shouldFinish?: (context: EffectSourceContext<S>) => boolean;
}

export function createEffectSourceProgramRef<S extends object>(
    id: string,
): EffectSourceProgramRef<S> {
    if (id.length === 0) {
        throw new TypeError("effect source program identity must be nonempty");
    }

    return Object.freeze({ id }) as EffectSourceProgramRef<S>;
}

export function effectSourceInstallation<S extends object>(
    ref: EffectProgramRef<S>,
    input: EffectSourceInstallationInput<NoInfer<S>>,
): EffectSourceInstallation {
    return (install) => install(ref, input);
}
