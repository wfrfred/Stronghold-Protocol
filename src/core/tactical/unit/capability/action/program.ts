import type { CombatWork } from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";
import type { ActionDefinition, TargetBindingId } from "./capability.js";
import type { CompiledActionSegment } from "./process.js";

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
    readonly process?: readonly CompiledActionSegment[];
}

export function ownCompiledAction(compiled: CompiledAction): CompiledAction {
    return Object.freeze({
        definition: compiled.definition,
        bind: compiled.bind,
        program: Object.freeze([...compiled.program]),
        ...(compiled.process === undefined
            ? {}
            : {
                  process: Object.freeze(
                      compiled.process.map((segment) => Object.freeze({ ...segment })),
                  ),
              }),
    });
}
