import {
    closeEffectLifetimes,
    expireEffects,
    finalizeFinishedEffects,
} from "../../unit/capability/effects/lifecycle.js";
import { EffectDispatchScope } from "../../unit/capability/effects/dispatch.js";
import type { LifetimeRef } from "../../unit/capability/effects/instance.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import type { EffectTransitionResources } from "../../unit/capability/effects/contract.js";
import type {
    StoppedSkillActivation,
    stopSkillActivation,
} from "../../unit/capability/skill/execution.js";
import type { ActionExecutionSignal } from "../../unit/capability/action/process.js";
import { appendEvents, battlefieldView, getUnit, removeUnit, type BattleState } from "./context.js";

export interface UnitLifecycleResources extends EffectTransitionResources {
    readonly stopSkillActivation: (
        work: BattleState,
        unitId: UnitId,
        tick: number,
    ) => ReturnType<typeof stopSkillActivation>;
    readonly notifySkillFinished: (
        work: BattleState,
        activation: StoppedSkillActivation,
        tick: number,
        dispatch: EffectDispatchScope,
    ) => BattleState;
}

export function retireCombatUnit(
    work: BattleState,
    unitId: UnitId,
    resources: UnitLifecycleResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): BattleState {
    return removeUnitWithEffects(work, unitId, "DEATH", resources, tick, dispatch);
}

export function removeUnitWithEffects(
    work: BattleState,
    unitId: UnitId,
    reason: BattlefieldRemovalReason,
    resources: UnitLifecycleResources,
    tick: number,
    dispatch = new EffectDispatchScope(),
): BattleState {
    const unit = getUnit(work, unitId);
    const lifetime: LifetimeRef = { type: "UNIT", unitId };

    if (unit === undefined || dispatch.isClosing(lifetime)) {
        return work;
    }

    const actions = work.actionExecutions?.forSource(unitId) ?? [];
    const stopped = resources.stopSkillActivation(work, unitId, tick);
    const lifetimes: LifetimeRef[] = [
        lifetime,
        ...(stopped.activation === null
            ? []
            : [
                  {
                      type: "SKILL" as const,
                      unitId,
                      activationId: stopped.activation.active.id,
                  },
              ]),
        ...actions.map(({ id }) => ({ type: "ACTION" as const, executionId: id })),
    ];
    dispatch.markClosing(lifetimes);
    work = stopped.work;

    for (const action of actions) {
        work.actionExecutions!.remove(action);
    }

    const signals: ActionExecutionSignal[] = actions.map(({ id }) => ({
        type: "ACTION_CANCELLED",
        executionId: id,
        sourceUnitId: unitId,
        tick,
        reason: "SOURCE_ABSENT",
    }));
    work = closeEffectLifetimes(work, lifetimes, resources, tick, reason, dispatch);

    const finishRemoval = (current: BattleState): BattleState => {
        if (stopped.activation !== null) {
            current = resources.notifySkillFinished(current, stopped.activation, tick, dispatch);
        }

        current = appendEvents(current, signals);
        current = finalizeFinishedEffects(current, unitId, resources, tick, dispatch);

        return removeUnit(current, unitId, reason);
    };

    if (dispatch.hasPendingEnds()) {
        dispatch.deferUnitRemoval(unitId, finishRemoval);

        return work;
    }

    return finishRemoval(work);
}

export function prepareCombatEffects(
    work: BattleState,
    tick: number,
    resources: EffectTransitionResources,
): BattleState {
    work = expireEffects(work, tick, resources);

    for (const id of battlefieldView(work).unitIds) {
        work = finalizeFinishedEffects(work, id, resources, tick);
    }

    return work;
}
