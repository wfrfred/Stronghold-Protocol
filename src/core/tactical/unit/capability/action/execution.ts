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
import type { CompiledAction } from "./program.js";

export interface ActionStep {
    readonly units: readonly Unit[];
    readonly removedUnitIds: readonly UnitId[];
    readonly events: readonly BattleEvent[];
}

export interface ActionStepContext {
    readonly battlefield: CombatTargetingView;
    readonly tick: number;
}

export function executeAction(
    work: CombatWork,
    sourceUnitId: UnitId,
    compiled: CompiledAction,
    tick: number,
): CombatWork {
    const source = getCombatUnit(work, sourceUnitId);

    if (source === undefined || !hasAction(source)) {
        return work;
    }

    let context = compiled.bind({ work, sourceUnitId, tick, bindings: new Map() });
    const targetUnitId = context.bindings.get(compiled.definition.triggerBindingId)![0] ?? null;
    const current = getCombatUnit(context.work, sourceUnitId);

    if (current === undefined || !hasAction(current)) {
        return context.work;
    }

    let acting = current;

    if (targetUnitId !== current.action.targetUnitId) {
        acting = { ...current, action: { ...current.action, targetUnitId } };
    }

    work = updateCombatUnit(context.work, acting);

    if (
        targetUnitId === null ||
        tick < acting.action.readyAtTick ||
        tick < acting.action.recoveryUntilTick
    ) {
        return work;
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
    context = { ...context, work };

    for (const step of compiled.program) {
        context = step(context);
    }

    return context.work;
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
