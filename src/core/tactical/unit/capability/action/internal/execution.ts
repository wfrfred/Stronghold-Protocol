import type { ActionExecutionWork } from "./executions.js";
import {
    appendEvents,
    battlefieldView,
    getUnit,
    updateUnit,
    type BattleState,
} from "../../../../battle/execution/context.js";
import { hasAction } from "../capability.js";
import { acceptActionExecutionInWork, resumeActionExecutionInWork } from "./process.js";
import { isSpatiallyPresent } from "../../presence.js";
import {
    beginActionCooldown,
    reconcileActionCooldown,
    resolveActionIntervalTicks,
} from "../timing.js";
import { hasStatusFlag } from "../../status/capability.js";
import type { ActionStartRequest, ActionStartResources } from "../execution.js";

export function startActionInWork(
    work: BattleState,
    executions: ActionExecutionWork,
    request: ActionStartRequest,
    resources: ActionStartResources,
): void {
    const { sourceUnitId, compiled, tick, mayStart } = request;
    const source = getUnit(work, sourceUnitId);

    if (
        source === undefined ||
        !hasAction(source) ||
        !isSpatiallyPresent(source) ||
        hasStatusFlag(source, "STUNNED")
    ) {
        return;
    }

    const intervalTicks = resolveActionIntervalTicks(
        compiled.definition,
        source.definition.action,
        source.action,
        resources.computations.bind({ unit: source, battlefield: battlefieldView(work) }),
    );
    const action = reconcileActionCooldown(source.action, intervalTicks, tick);
    const ready = action === source.action ? source : { ...source, action };
    updateUnit(work, ready);

    if (!mayStart || tick < action.readyAtTick || tick < action.recoveryUntilTick) {
        return;
    }

    const bindings = compiled.bind({ source: ready, battlefield: battlefieldView(work) });
    const targetUnitId = bindings.get(compiled.definition.triggerBindingId)![0] ?? null;

    if (targetUnitId === null) {
        return;
    }

    const { definition } = compiled;
    const executing = {
        ...ready,
        action: beginActionCooldown(action, definition, intervalTicks, tick),
    };
    updateUnit(work, executing);
    appendEvents(work, [{ type: "ACTION", sourceUnitId, targetUnitId, tick }]);

    if (work.actionExecutions !== executions) {
        work.actionExecutions = executions;
    }

    const initialized = acceptActionExecutionInWork(executions, {
        sourceUnitId,
        definition,
        inputTargetUnitId: targetUnitId,
        bindings,
        tick,
    });
    resumeActionExecutionInWork(
        work,
        executions,
        { executionId: initialized.id, segments: compiled.program, tick },
        resources,
    );
}
