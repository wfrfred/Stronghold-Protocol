import type { UnitId } from "../../unit.js";
import { selectTargets } from "../../targeting/select.js";
import { compileTargeting } from "../../targeting/compile.js";
import { resolveMaxHp } from "../vitality/query.js";
import type { ActionDefinition, TargetBindingId } from "./capability.js";
import * as operation from "./operation.js";
import type { ActionResources } from "./resources.js";
import type { CompiledAction } from "./program.js";
import type { ActionExecutionContext, CompiledActionSegment } from "./process.js";

export function compileAction(
    definition: ActionDefinition,
    resources: ActionResources,
    compile: (definition: operation.Definition) => operation.Program = (definition) =>
        operation.compile(definition, resources),
): CompiledAction {
    const groups = definition.targetGroups.map((group) => ({
        id: group.id,
        targeting: compileTargeting(
            group.targeting,
            group.operations.flatMap(operation.purposes),
            (unit, context) => resolveMaxHp(unit.id, context.battlefield)!,
        ),
        operations: group.operations.map(compile),
    }));

    const applyTo = (
        run: operation.Program,
        ids: (context: ActionExecutionContext) => readonly UnitId[],
    ): CompiledActionSegment => ({
        type: "EXECUTE",
        run: (context) => {
            let { work } = context;

            for (const targetUnitId of ids(context)) {
                work = run({
                    work,
                    sourceUnitId: context.sourceUnitId,
                    targetUnitId,
                    tick: context.tick,
                });
            }

            return { work };
        },
    });

    const program = groups.flatMap((group) =>
        group.operations.map((run) => applyTo(run, (context) => context.bindings.get(group.id)!)),
    );

    for (const { receiver, operation: followUp } of definition.followUps) {
        const ids =
            receiver.type === "SOURCE"
                ? (context: ActionExecutionContext) => [context.sourceUnitId]
                : (context: ActionExecutionContext) => context.bindings.get(receiver.bindingId)!;

        program.push(applyTo(compile(followUp), ids));
    }

    return {
        definition,
        bind: (query) => {
            const bindings = new Map<TargetBindingId, readonly UnitId[]>();

            for (const group of groups) {
                bindings.set(
                    group.id,
                    selectTargets(query, group.targeting).map((unit) => unit.id),
                );
            }

            return bindings;
        },
        program,
    };
}
