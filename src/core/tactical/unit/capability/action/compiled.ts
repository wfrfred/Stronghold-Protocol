import type { Id } from "../../unit.js";
import type { ActionDefinition, TargetBindingId } from "./capability.js";
import type { CompiledActionSegment } from "./process.js";
import type { CombatTargetQueryContext } from "../../targeting/query.js";

export interface CompiledAction {
    readonly definition: ActionDefinition;
    readonly bind: (
        context: CombatTargetQueryContext,
    ) => ReadonlyMap<TargetBindingId, readonly Id[]>;
    readonly program: readonly CompiledActionSegment[];
}
