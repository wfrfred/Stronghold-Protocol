import type { Id } from "../../unit.js";
import type { CombatTargetingView } from "../../targeting/query.js";
import type { BattleState, Result } from "../../../battle/state.js";
import type { CallContext } from "../../../battle/execution/call.js";
import type { Definition } from "./capability.js";

export type SkillFacts = CombatTargetingView;

export interface SkillQueryContext {
    readonly unitId: Id;
    readonly tick: number;
    readonly battlefield: SkillFacts;
}

export interface SkillActivationContext extends SkillQueryContext {
    readonly activationId: number;
    readonly endsAtTick: number | null;
    readonly call: CallContext;
}

export type SkillContentResult =
    { readonly type: "ACTIVATED" } | { readonly type: "REJECTED"; readonly reason: string };

export interface CompiledSkill {
    readonly definition: Definition;
    readonly accepts?: (context: SkillQueryContext) => boolean;
    readonly activate: (
        state: BattleState,
        context: SkillActivationContext,
    ) => Result<SkillContentResult>;
    readonly finish?: (state: BattleState, context: SkillActivationContext) => BattleState;
}
