import type { ActionExecutionWork } from "./executions.js";
import {
    appendCombatEvents,
    combatWorkView,
    getCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "../../../../battle/execution/work.js";
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
    work: CombatWork,
    executions: ActionExecutionWork,
    request: ActionStartRequest,
    resources: ActionStartResources,
): CombatWork {
    const { sourceUnitId, compiled, tick, mayStart } = request;
    const source = getCombatUnit(work, sourceUnitId);

    if (
        source === undefined ||
        !hasAction(source) ||
        !isSpatiallyPresent(source) ||
        hasStatusFlag(source, "STUNNED")
    ) {
        return work;
    }

    const intervalTicks = resolveActionIntervalTicks(
        compiled.definition,
        source.definition.action,
        source.action,
        resources.computations.bind({ unit: source, battlefield: combatWorkView(work) }),
    );
    const action = reconcileActionCooldown(source.action, intervalTicks, tick);
    const ready = action === source.action ? source : { ...source, action };
    work = updateCombatUnit(work, ready);

    if (!mayStart || tick < action.readyAtTick || tick < action.recoveryUntilTick) {
        return work;
    }

    const bindings = compiled.bind({ source: ready, battlefield: combatWorkView(work) });
    const targetUnitId = bindings.get(compiled.definition.triggerBindingId)![0] ?? null;

    if (targetUnitId === null) {
        return work;
    }

    const { definition } = compiled;
    const executing = {
        ...ready,
        action: beginActionCooldown(action, definition, intervalTicks, tick),
    };
    work = updateCombatUnit(work, executing);
    work = appendCombatEvents(work, [{ type: "ACTION", sourceUnitId, targetUnitId, tick }]);

    const initialized = acceptActionExecutionInWork(executions, {
        sourceUnitId,
        definition,
        inputTargetUnitId: targetUnitId,
        bindings,
        tick,
    });
    const advanced = resumeActionExecutionInWork(
        work,
        executions,
        { executionId: initialized.id, segments: compiled.program, tick },
        resources,
    );

    return advanced.work;
}
