import type { UnitId } from "../../unit.js";
import type { CombatTargetingView } from "../../targeting/query.js";
import type { EffectLifecycleOperations } from "../effects/contract.js";
import type { EffectAddress } from "../effects/instance.js";
import type { SkillDefinition } from "./capability.js";
import type { DamageReport, DamageRequest } from "../vitality/damage/contract.js";
import type { HealingReport, HealingRequest } from "../vitality/healing/contract.js";

export type SkillFacts = CombatTargetingView;

export interface SkillQueryContext {
    readonly unitId: UnitId;
    readonly tick: number;
    readonly facts: SkillFacts;
}

export interface SkillActivationContext extends SkillQueryContext {
    readonly activationId: number;
    readonly endsAtTick: number | null;
    readonly effects: EffectLifecycleOperations;
    damage(request: Omit<DamageRequest, "tick">): DamageReport;
    heal(request: HealingRequest): HealingReport;
}

export type SkillContentResult =
    | { readonly type: "ACTIVATED"; readonly ownedEffects?: readonly EffectAddress[] }
    | { readonly type: "REJECTED"; readonly reason: string };

export interface CompiledSkill {
    readonly definition: SkillDefinition;
    readonly accepts?: (context: SkillQueryContext) => boolean;
    readonly activate: (context: SkillActivationContext) => SkillContentResult;
    readonly finish?: (context: SkillActivationContext) => undefined;
}
