import type { BattleEvent } from "../../../battle/contract.js";
import {
    appendCombatEvents,
    combatWorkResult,
    combatWorkView,
    createCombatWork,
    getCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "../../../battle/execution/work.js";
import type { CombatTargetingView } from "../../targeting/query.js";
import type { Unit, UnitId } from "../../unit.js";
import { hasAction, type Action, type ActingUnitDefinition } from "./capability.js";
import type { CompiledAction } from "./program.js";
import type { EffectTransitionResources } from "../effects/contract.js";
import {
    acceptActionExecution,
    createActionExecutionState,
    resumeActionExecution,
    type ActionExecutionState,
} from "./process.js";
import type { ProjectileOperations } from "../../../battlefield/projectile/operations.js";
import { isSpatiallyPresent } from "../presence.js";

export interface ActionStep {
    readonly state: ActionExecutionState;
    readonly units: readonly Unit[];
    readonly removedUnitIds: readonly UnitId[];
    readonly events: readonly BattleEvent[];
}

export interface ActionStepContext {
    readonly battlefield: CombatTargetingView;
    readonly tick: number;
    readonly state?: ActionExecutionState;
    readonly projectiles?: ProjectileOperations;
}

export function startAction(
    work: CombatWork,
    state: ActionExecutionState,
    sourceUnitId: UnitId,
    compiled: CompiledAction,
    tick: number,
    resources: EffectTransitionResources,
    mayStart: boolean,
    projectiles?: ProjectileOperations,
): { readonly work: CombatWork; readonly state: ActionExecutionState } {
    const source = getCombatUnit(work, sourceUnitId);

    if (
        !mayStart ||
        source === undefined ||
        !hasAction(source) ||
        !isSpatiallyPresent(source) ||
        tick < source.action.readyAtTick ||
        tick < source.action.recoveryUntilTick
    ) {
        return { work, state };
    }

    const bindings = compiled.bind({ source, battlefield: combatWorkView(work) });
    const targetUnitId = bindings.get(compiled.definition.triggerBindingId)![0] ?? null;

    if (targetUnitId === null) {
        return { work, state };
    }

    const { definition } = compiled;
    const executing = {
        ...source,
        action: {
            ...source.action,
            targetUnitId,
            readyAtTick: tick + definition.intervalTicks,
            recoveryUntilTick: tick + definition.recoveryTicks,
        },
    };
    work = updateCombatUnit(work, executing);
    work = appendCombatEvents(work, [{ type: "ACTION", sourceUnitId, targetUnitId, tick }]);

    const initialized = acceptActionExecution(state, {
        sourceUnitId,
        definition,
        inputTargetUnitId: targetUnitId,
        bindings,
        tick,
    });
    const advanced = resumeActionExecution(
        work,
        initialized.state,
        initialized.execution.id,
        compiled.program,
        tick,
        resources,
        projectiles,
    );

    return { work: advanced.work, state: advanced.state };
}

export function stepAction(
    source: Unit<ActingUnitDefinition> & Action,
    compiled: CompiledAction,
    context: ActionStepContext,
    resources: EffectTransitionResources,
): ActionStep {
    const result = startAction(
        updateCombatUnit(createCombatWork(context.battlefield), source),
        context.state ?? createActionExecutionState(),
        source.id,
        compiled,
        context.tick,
        resources,
        true,
        context.projectiles,
    );
    const { units, removedUnitIds, events } = combatWorkResult(result.work);

    return { state: result.state, units, removedUnitIds, events };
}
