import {
    closeEffectLifetimes,
    expireEffects,
    finalizeFinishedEffects,
} from "../../unit/capability/effects/lifecycle.js";
import { EffectDispatchScope } from "../../unit/capability/effects/dispatch.js";
import type { LifetimeRef } from "../../unit/capability/effects/effect.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import type { EffectTransitionResources } from "../../unit/capability/effects/contract.js";
import type { StoppedSkillActivation } from "../../unit/capability/skill/execution.js";
import type { ActionExecutionSignal } from "../../unit/capability/action/process.js";
import { appendEvents, battlefieldView, getUnit, removeUnit, type BattleState } from "./context.js";

export interface UnitLifecycleResources extends EffectTransitionResources {
    readonly stopSkillActivation: (
        state: BattleState,
        unitId: UnitId,
        tick: number,
    ) => StoppedSkillActivation | null;
    readonly notifySkillFinished: (
        state: BattleState,
        activation: StoppedSkillActivation,
        tick: number,
        dispatch: EffectDispatchScope,
    ) => void;
}

export function retireCombatUnit(
    state: BattleState,
    unitId: UnitId,
    resources: UnitLifecycleResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): void {
    removeUnitWithEffects(state, unitId, "DEATH", resources, tick, dispatch);
}

export function removeUnitWithEffects(
    state: BattleState,
    unitId: UnitId,
    reason: BattlefieldRemovalReason,
    resources: UnitLifecycleResources,
    tick: number,
    dispatch = new EffectDispatchScope(),
): void {
    const unit = getUnit(state, unitId);
    const lifetime: LifetimeRef = { type: "UNIT", unitId };

    if (unit === undefined || dispatch.isClosing(lifetime)) {
        return;
    }

    const actions = state.actionExecutions?.forSource(unitId) ?? [];
    const stopped = resources.stopSkillActivation(state, unitId, tick);
    const lifetimes: LifetimeRef[] = [
        lifetime,
        ...(stopped === null
            ? []
            : [
                  {
                      type: "SKILL" as const,
                      unitId,
                      activationId: stopped.active.id,
                  },
              ]),
        ...actions.map(({ id }) => ({ type: "ACTION" as const, executionId: id })),
    ];
    dispatch.markClosing(lifetimes);

    for (const action of actions) {
        state.actionExecutions!.remove(action);
    }

    const signals: ActionExecutionSignal[] = actions.map(({ id }) => ({
        type: "ACTION_CANCELLED",
        executionId: id,
        sourceUnitId: unitId,
        tick,
        reason: "SOURCE_ABSENT",
    }));
    closeEffectLifetimes(state, lifetimes, resources, tick, reason, dispatch);

    const finishRemoval = (): void => {
        if (stopped !== null) {
            resources.notifySkillFinished(state, stopped, tick, dispatch);
        }

        appendEvents(state, signals);
        finalizeFinishedEffects(state, unitId, resources, tick, dispatch);

        removeUnit(state, unitId, reason);
    };

    if (dispatch.hasPendingEnds()) {
        dispatch.deferUnitRemoval(unitId, finishRemoval);

        return;
    }

    finishRemoval();
}

export function prepareCombatEffects(
    state: BattleState,
    tick: number,
    resources: EffectTransitionResources,
): void {
    expireEffects(state, tick, resources);

    for (const id of battlefieldView(state).unitIds) {
        finalizeFinishedEffects(state, id, resources, tick);
    }
}
