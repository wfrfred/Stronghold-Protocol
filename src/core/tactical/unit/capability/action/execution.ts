import type { BattleEvent } from "../../../battle/contract.js";
import {
    appendCombatEvents,
    combatWorkResult,
    createCombatWork,
    getCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "../../../battle/execution/work.js";
import type { CombatTargetingView } from "../../targeting/query.js";
import type { Unit, UnitId } from "../../unit.js";
import { hasAction, type Action, type ActingUnitDefinition } from "./capability.js";
import type { ActionProgramContext, CompiledAction } from "./program.js";
import type { EffectTransitionResources } from "../effects/contract.js";
import {
    acceptActionExecution,
    resumeActionExecution,
    type ActionExecutionState,
} from "./process.js";

export interface ActionStep {
    readonly units: readonly Unit[];
    readonly removedUnitIds: readonly UnitId[];
    readonly events: readonly BattleEvent[];
}

export interface ActionStepContext {
    readonly battlefield: CombatTargetingView;
    readonly tick: number;
}

interface ActionAcceptance {
    readonly work: CombatWork;
    readonly context: ActionProgramContext | null;
}

function acceptAction(
    work: CombatWork,
    sourceUnitId: UnitId,
    compiled: CompiledAction,
    tick: number,
    mayStart: boolean,
): ActionAcceptance {
    const source = getCombatUnit(work, sourceUnitId);

    if (source === undefined || !hasAction(source)) {
        return { work, context: null };
    }

    const context = compiled.bind({ work, sourceUnitId, tick, bindings: new Map() });
    const targetUnitId = context.bindings.get(compiled.definition.triggerBindingId)![0] ?? null;
    const current = getCombatUnit(context.work, sourceUnitId);

    if (current === undefined || !hasAction(current)) {
        return { work: context.work, context: null };
    }

    let acting = current;

    if (targetUnitId !== current.action.targetUnitId) {
        acting = { ...current, action: { ...current.action, targetUnitId } };
    }

    work = updateCombatUnit(context.work, acting);

    if (
        !mayStart ||
        targetUnitId === null ||
        tick < acting.action.readyAtTick ||
        tick < acting.action.recoveryUntilTick
    ) {
        return { work, context: null };
    }

    const { definition } = compiled;
    const executing = {
        ...acting,
        action: {
            ...acting.action,
            readyAtTick: tick + definition.intervalTicks,
            recoveryUntilTick: tick + definition.recoveryTicks,
        },
    };

    work = updateCombatUnit(work, executing);
    work = appendCombatEvents(work, [{ type: "ACTION", sourceUnitId, targetUnitId, tick }]);

    return { work, context: { ...context, work } };
}

function runImmediateAction(context: ActionProgramContext, compiled: CompiledAction): CombatWork {
    for (const step of compiled.program) {
        context = step(context);
    }

    return context.work;
}

export function executeAction(
    work: CombatWork,
    sourceUnitId: UnitId,
    compiled: CompiledAction,
    tick: number,
): CombatWork {
    if (compiled.process !== undefined) {
        throw new TypeError("resumable actions require an execution state");
    }

    const accepted = acceptAction(work, sourceUnitId, compiled, tick, true);

    return accepted.context === null
        ? accepted.work
        : runImmediateAction(accepted.context, compiled);
}

export function startAction(
    work: CombatWork,
    state: ActionExecutionState,
    sourceUnitId: UnitId,
    compiled: CompiledAction,
    tick: number,
    resources: EffectTransitionResources,
    mayStart: boolean,
): { readonly work: CombatWork; readonly state: ActionExecutionState } {
    const accepted = acceptAction(work, sourceUnitId, compiled, tick, mayStart);

    if (accepted.context === null) {
        return { work: accepted.work, state };
    }
    if (compiled.process === undefined) {
        return { work: runImmediateAction(accepted.context, compiled), state };
    }

    const initialized = acceptActionExecution(state, {
        sourceUnitId,
        definition: compiled.definition,
        inputTargetUnitId: accepted.context.bindings.get(compiled.definition.triggerBindingId)![0]!,
        bindings: accepted.context.bindings,
        tick,
    });
    const advanced = resumeActionExecution(
        accepted.work,
        initialized.state,
        initialized.execution.id,
        compiled.process,
        tick,
        resources,
    );

    return { work: advanced.work, state: advanced.state };
}

export function stepAction(
    source: Unit<ActingUnitDefinition> & Action,
    compiled: CompiledAction,
    context: ActionStepContext,
): ActionStep {
    const work = executeAction(
        updateCombatUnit(createCombatWork(context.battlefield), source),
        source.id,
        compiled,
        context.tick,
    );
    const { units, removedUnitIds, events } = combatWorkResult(work);

    return { units, removedUnitIds, events };
}
