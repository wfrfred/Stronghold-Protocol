import type { Unit, UnitId } from "../../unit.js";
import type { CombatWork } from "../../../battle/execution/work.js";
import type {
    EffectAddress,
    EffectInstanceValue,
    EffectLifetimeScope,
    EffectInstanceMetadata,
} from "./instance.js";
import type { EffectProgramRef } from "./program.js";
import type { EffectResources } from "./registry.js";
import type { EffectBindings } from "./resources.js";
import type { EffectLifecycleResources } from "./lifecycle-resources.js";

export interface EffectView {
    getUnit(id: UnitId): Unit | undefined;
    getEffect(address: EffectAddress): EffectInstanceValue | undefined;
    participating(unitId: UnitId): readonly EffectInstanceValue[];
}

export interface EffectLifecycleOperations {
    install<S extends object>(
        unitId: UnitId,
        ref: EffectProgramRef<S>,
        input: EffectInstallationInput<NoInfer<S>>,
    ): EffectInstallationResult;
    update<S extends object>(
        address: EffectAddress,
        ref: EffectProgramRef<S>,
        transition: (current: NoInfer<S>) => NoInfer<S>,
    ): void;
    setEnabled(address: EffectAddress, enabled: boolean): void;
    setExpiration(address: EffectAddress, expiresAtTick: number | null): void;
    finish(address: EffectAddress): void;
    attachParent(
        child: EffectAddress,
        parent: EffectAddress,
        finishIfParentFinished?: boolean,
    ): EffectParentBindingResult;
}

export interface EffectLifecycleContext<S extends object = object> {
    readonly address: EffectAddress;
    readonly instance: EffectInstanceValue & { readonly state: S };
    readonly tick: number;
    readonly facts: EffectView;
    readonly effects: EffectLifecycleOperations;
}

export interface EffectAdmissionContext<S extends object = object> {
    readonly address: EffectAddress;
    readonly instance: EffectInstanceValue & { readonly state: S };
    readonly facts: EffectView;
}

export type EffectLifecycleAction<S extends object> = (
    context: EffectLifecycleContext<S>,
) => undefined;

export interface EffectLifecycleProgram<S extends object> {
    readonly start?: EffectLifecycleAction<S>;
    readonly enable?: EffectLifecycleAction<S>;
    readonly disable?: EffectLifecycleAction<S>;
    readonly finalize?: EffectLifecycleAction<S>;
    readonly accepts?: (context: EffectAdmissionContext<S>) => boolean;
    readonly competition?: (instance: EffectCompetitionInput<S>) => EffectCompetition | undefined;
}

export interface EffectCompetitionInput<S extends object> extends Pick<
    EffectInstanceMetadata,
    "id" | "source" | "acquiredSequence"
> {
    readonly programRef: { readonly id: string };
    readonly state: S;
}

export interface EffectCompetition {
    readonly group: string;
    readonly priority: number;
}

export interface EffectTransitionResources {
    readonly effects: Pick<EffectResources, "create" | "restore" | "typedInstance" | "update">;
    readonly effectBindings: EffectBindings;
    readonly effectLifecycle: Pick<EffectLifecycleResources, "get">;
}

export interface EffectInstallationInput<S extends object = object> {
    readonly source: UnitId | null;
    readonly scope: EffectLifetimeScope | null;
    readonly expiresAtTick: number | null;
    readonly initialState?: S;
}

export type EffectInstallationResult =
    | { readonly type: "INSTALLED"; readonly address: EffectAddress }
    | {
          readonly type: "REJECTED";
          readonly reason: "TARGET_ABSENT" | "START_FINISHED" | "ADMISSION_REJECTED";
          readonly address: EffectAddress;
      };

export interface EffectInstallation {
    readonly work: CombatWork;
    readonly result: EffectInstallationResult;
}

export type EffectParentBindingResult =
    | { readonly type: "BOUND" }
    | { readonly type: "CHILD_ABSENT" }
    | { readonly type: "CHILD_FINISHED" }
    | { readonly type: "PARENT_UNAVAILABLE"; readonly reason: "ABSENT" | "FINISHED" };

export interface EffectParentBinding {
    readonly work: CombatWork;
    readonly result: EffectParentBindingResult;
}
