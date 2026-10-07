import type { CombatWork } from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";
import type { ActionDefinition, TargetBindingId } from "./capability.js";

export interface ActionProgramContext {
    readonly work: CombatWork;
    readonly sourceUnitId: UnitId;
    readonly tick: number;
    readonly bindings: ReadonlyMap<TargetBindingId, readonly UnitId[]>;
}

export type ActionProgramStep = (context: ActionProgramContext) => ActionProgramContext;

export interface CompiledAction {
    readonly definition: ActionDefinition;
    readonly bind: ActionProgramStep;
    readonly program: readonly ActionProgramStep[];
}
