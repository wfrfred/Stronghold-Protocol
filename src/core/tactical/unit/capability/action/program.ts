import type { UnitId } from "../../unit.js";
import type { ActionDefinition, TargetBindingId } from "./capability.js";
import type { CompiledActionSegment } from "./process.js";
import type { CombatTargetQueryContext } from "../../targeting/query.js";

export interface CompiledAction {
    readonly definition: ActionDefinition;
    readonly bind: (
        context: CombatTargetQueryContext,
    ) => ReadonlyMap<TargetBindingId, readonly UnitId[]>;
    readonly program: readonly CompiledActionSegment[];
}

export function ownCompiledAction(compiled: CompiledAction): CompiledAction {
    return Object.freeze({
        definition: compiled.definition,
        bind: compiled.bind,
        program: Object.freeze(compiled.program.map((segment) => Object.freeze({ ...segment }))),
    });
}
