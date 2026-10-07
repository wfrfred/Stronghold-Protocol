import type { Unit, UnitId } from "../../unit.js";
import type { CombatWork } from "../../../battle/execution/work.js";
import type { EffectAddress, EffectInstanceValue, EffectLifetimeOwner } from "./instance.js";
import type { EffectProgramRef } from "./program.js";
import type { EffectResources } from "./registry.js";
import type { EffectContributionBindings } from "./resources.js";
import type { EffectLifecycleResources } from "./lifecycle-resources.js";

export interface EffectFacts {
    getUnit(id: UnitId): Unit | undefined;
    getEffect(address: EffectAddress): EffectInstanceValue | undefined;
    participating(unitId: UnitId): readonly EffectInstanceValue[];
}

export interface EffectLifecycleOperations {
    install<S extends object>(
        unitId: UnitId,
        ref: EffectProgramRef<S>,
        input: EffectInstallationInput,
    ): EffectInstallationResult;
    update<S extends object>(
        address: EffectAddress,
        ref: EffectProgramRef<S>,
        transition: (current: NoInfer<S>) => NoInfer<S>,
    ): void;
    setParticipation(address: EffectAddress, participating: boolean): void;
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
    readonly facts: EffectFacts;
    readonly effects: EffectLifecycleOperations;
}

export interface EffectAdmissionContext<S extends object = object> {
    readonly address: EffectAddress;
    readonly instance: EffectInstanceValue & { readonly state: S };
    readonly facts: EffectFacts;
}

export type EffectLifecycleAction<S extends object> = (context: EffectLifecycleContext<S>) => void;

export interface EffectLifecycleProgram<S extends object> {
    readonly start?: EffectLifecycleAction<S>;
    readonly enable?: EffectLifecycleAction<S>;
    readonly disable?: EffectLifecycleAction<S>;
    readonly finalize?: EffectLifecycleAction<S>;
    readonly accepts?: (context: EffectAdmissionContext<S>) => boolean;
}

export interface EffectTransitionResources {
    readonly effects: Pick<
        EffectResources,
        "assertInstance" | "create" | "typedInstance" | "update"
    >;
    readonly effectBindings: EffectContributionBindings;
    readonly effectLifecycle: Pick<EffectLifecycleResources, "get">;
}

export interface EffectInstallationInput {
    readonly sourceUnitId: UnitId | null;
    readonly lifetimeOwner: EffectLifetimeOwner | null;
    readonly expiresAtTick: number | null;
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
