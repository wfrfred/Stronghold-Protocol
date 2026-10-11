import { endScope } from "../../unit/effect/operations.js";
import { key } from "../../unit/effect/effect.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import type { StoppedSkillActivation } from "../../unit/capability/skill/execution.js";
import type { ActionExecutionSignal } from "../../unit/capability/action/process.js";
import { appendEvents, getUnit, removeUnit, type BattleState } from "./context.js";

export interface UnitLifecycleResources {
    readonly stopSkillActivation: (
        battle: BattleState,
        unitId: UnitId,
        tick: number,
    ) => StoppedSkillActivation | null;
    readonly notifySkillFinished: (
        battle: BattleState,
        activation: StoppedSkillActivation,
        tick: number,
    ) => void;
}

export function retireCombatUnit(
    battle: BattleState,
    unitId: UnitId,
    resources: UnitLifecycleResources,
    tick: number,
): void {
    removeUnitWithEffects(battle, unitId, "DEATH", resources, tick);
}

export function removeUnitWithEffects(
    battle: BattleState,
    unitId: UnitId,
    reason: BattlefieldRemovalReason,
    resources: UnitLifecycleResources,
    tick: number,
): void {
    const lifetime = { type: "UNIT" as const, unitId };

    if (getUnit(battle, unitId) === undefined || battle.closedLifetimes.has(key(lifetime))) {
        return;
    }

    battle.closedLifetimes.add(key(lifetime));
    const actions = battle.actionExecutions?.forSource(unitId) ?? [];
    const stopped = resources.stopSkillActivation(battle, unitId, tick);

    for (const action of actions) {
        battle.actionExecutions!.remove(action);
        endScope(battle, { type: "ACTION", executionId: action.id }, reason);
    }
    if (stopped !== null) {
        endScope(battle, { type: "SKILL", unitId, activationId: stopped.active.id }, reason);
    }

    endScope(battle, lifetime, reason);

    if (stopped !== null) {
        resources.notifySkillFinished(battle, stopped, tick);
    }

    const signals: ActionExecutionSignal[] = actions.map(({ id }) => ({
        type: "ACTION_CANCELLED",
        executionId: id,
        sourceUnitId: unitId,
        tick,
        reason: "SOURCE_ABSENT",
    }));
    appendEvents(battle, signals);
    removeUnit(battle, unitId, reason);
}
