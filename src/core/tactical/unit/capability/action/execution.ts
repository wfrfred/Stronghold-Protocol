import { ActionExecutionWork } from "./internal/executions.js";
import {
    appendCombatEvents,
    combatWorkView,
    getCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";
import { hasAction } from "./capability.js";
import type { CompiledAction } from "./program.js";
import type { EffectTransitionResources } from "../effects/contract.js";
import {
    acceptActionExecutionInWork,
    resumeActionExecutionInWork,
    type ActionExecutionState,
} from "./process.js";
import type { ProjectileOperations } from "../../../battlefield/projectile/operations.js";
import { isSpatiallyPresent } from "../presence.js";
import type { ActionResources } from "./resources.js";
import {
    beginActionCooldown,
    reconcileActionCooldown,
    resolveActionIntervalTicks,
} from "./timing.js";
import { hasStatusFlag } from "../status/capability.js";

type ActionExecutionResources = EffectTransitionResources & Pick<ActionResources, "computations">;

export function startAction(
    work: CombatWork,
    state: ActionExecutionState,
    sourceUnitId: UnitId,
    compiled: CompiledAction,
    tick: number,
    resources: ActionExecutionResources,
    mayStart: boolean,
    projectiles?: ProjectileOperations,
): { readonly work: CombatWork; readonly state: ActionExecutionState } {
    const executions = new ActionExecutionWork(state);
    const next = startActionInWork(
        work,
        executions,
        sourceUnitId,
        compiled,
        tick,
        resources,
        mayStart,
        projectiles,
    );

    return { work: next, state: executions.result() };
}

export function startActionInWork(
    work: CombatWork,
    executions: ActionExecutionWork,
    sourceUnitId: UnitId,
    compiled: CompiledAction,
    tick: number,
    resources: ActionExecutionResources,
    mayStart: boolean,
    projectiles?: ProjectileOperations,
): CombatWork {
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
        initialized.id,
        compiled.program,
        tick,
        resources,
        projectiles,
    );

    return advanced.work;
}
