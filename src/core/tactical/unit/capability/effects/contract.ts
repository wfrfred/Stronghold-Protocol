import type { Unit, UnitId } from "../../unit.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type { EffectRef, EffectValue, Scope, EffectMetadata, LifetimeRef } from "./effect.js";
import type { EffectDefinitionRef } from "./definition.js";
import type { EffectResources } from "./registry.js";
import type { EffectBindings } from "./resources.js";
import type { EffectLifecycleResources } from "./lifecycle-resources.js";
import type { DamageOperation, DamageRequest, DamageReport } from "../vitality/damage/contract.js";
import type {
    HealingOperation,
    HealingRequest,
    HealingReport,
} from "../vitality/healing/contract.js";

export interface EffectView {
    getUnit(id: UnitId): Unit | undefined;
    getEffect(address: EffectRef): EffectValue | undefined;
    participating(unitId: UnitId): readonly EffectValue[];
}

export interface EffectLifecycleOperations {
    install<S extends object>(
        unitId: UnitId,
        ref: EffectDefinitionRef<S>,
        input: EffectInstallationInput<NoInfer<S>>,
    ): EffectInstallationResult;
    update<S extends object>(
        address: EffectRef,
        ref: EffectDefinitionRef<S>,
        transition: (current: NoInfer<S>) => NoInfer<S>,
    ): void;
    setEnabled(address: EffectRef, enabled: boolean): void;
    setTick(ref: EffectRef, tick: number | null): void;
    finish(refs: readonly EffectRef[], reason?: EffectEndReason): void;
    bind(ref: EffectRef, lifetime: LifetimeRef): EffectBindingResult;
}

export interface EffectLifecycleContext<S extends object = object> {
    readonly ref: EffectRef;
    readonly instance: EffectValue & { readonly state: S };
    readonly tick: number;
    readonly facts: EffectView;
    /** Each access reads the current draft; a saved view remains fixed. */
    readonly battlefield: BattlefieldView;
    readonly effects: EffectLifecycleOperations;
    damage(request: Omit<DamageRequest, "tick">): DamageReport;
    heal(request: Omit<HealingRequest, "tick">): HealingReport;
}

export interface EffectAdmissionContext<S extends object = object> {
    readonly unitId: UnitId;
    readonly instance: EffectValue & { readonly state: S };
    readonly facts: EffectView;
}

export type EffectEndReason = string;

export interface EffectEnd {
    readonly root: LifetimeRef;
    readonly reason: EffectEndReason;
}

export interface EffectFinishContext<S extends object = object> extends EffectLifecycleContext<S> {
    readonly end: EffectEnd;
}

export type EffectLifecycleAction<S extends object> = (
    context: EffectLifecycleContext<S>,
) => undefined;

export interface EffectLifecycleDefinition<S extends object> {
    readonly start?: EffectLifecycleAction<S>;
    readonly enable?: EffectLifecycleAction<S>;
    readonly disable?: EffectLifecycleAction<S>;
    /** Periodic work, called once per Runtime tick for participating effects. */
    readonly advance?: EffectLifecycleAction<S>;
    readonly expire?: EffectLifecycleAction<S>;
    readonly finish?: (context: EffectFinishContext<S>) => undefined;
    readonly accepts?: (context: EffectAdmissionContext<S>) => boolean;
    readonly competition?: (instance: EffectCompetitionInput<S>) => EffectCompetition | undefined;
}

export interface EffectCompetitionInput<S extends object> extends Pick<
    EffectMetadata,
    "id" | "source" | "acquiredSequence"
> {
    readonly definitionRef: { readonly id: string };
    readonly state: S;
}

export interface EffectCompetition {
    readonly group: string;
    readonly priority: number;
}

export interface EffectTransitionResources {
    readonly effects: Pick<EffectResources, "create" | "get" | "typedEffect" | "update">;
    readonly effectBindings: EffectBindings;
    readonly effectLifecycle: Pick<EffectLifecycleResources, "get">;
    readonly settleDamage?: DamageOperation;
    readonly settleHealing?: HealingOperation;
}

export interface EffectInstallationInput<S extends object = object> {
    readonly source: UnitId | null;
    readonly scopes: readonly Scope[];
    readonly initialState?: S;
}

export type EffectInstallationResult =
    | { readonly type: "INSTALLED" | "ENDED"; readonly ref: EffectRef }
    | {
          readonly type: "REJECTED";
          readonly reason:
              "TARGET_ABSENT" | "TARGET_CLOSING" | "LIFETIME_UNAVAILABLE" | "ADMISSION_REJECTED";
      };

export type EffectBindingResult =
    | { readonly type: "BOUND" }
    | { readonly type: "EFFECT_ABSENT" }
    | { readonly type: "EFFECT_FINISHED" }
    | { readonly type: "LIFETIME_UNAVAILABLE" };
