import { assertFiniteNumber } from "../../../../common/assert.js";
import * as contribution from "../../../contribution/state.js";
import * as modifier from "../../../contribution/value.js";
import type { ActionCapabilityDefinition, ActionDefinition, ActionState } from "./capability.js";

export function resolveAttackSpeed(
    definition: ActionCapabilityDefinition,
    state: ActionState,
    evaluate?: contribution.Evaluate,
): number {
    return Math.max(
        20,
        modifier.apply(
            definition.attackSpeed ?? 100,
            contribution.resolve(state.attackSpeed, evaluate),
        ),
    );
}

export function resolveBaseAttackTime(
    definition: ActionDefinition,
    state: ActionState,
    evaluate?: contribution.Evaluate,
): number {
    return Math.max(
        0,
        modifier.apply(
            definition.baseAttackTimeTicks,
            contribution.resolve(state.baseAttackTime, evaluate),
        ),
    );
}

export function resolveActionIntervalTicks(
    definition: ActionDefinition,
    capability: ActionCapabilityDefinition,
    state: ActionState,
    evaluate?: contribution.Evaluate,
): number {
    const attackSpeed = Math.min(600, resolveAttackSpeed(capability, state, evaluate));
    const interval = resolveBaseAttackTime(definition, state, evaluate) * (100 / attackSpeed);
    assertFiniteNumber(interval, "effective action interval");

    return Math.max(1, interval);
}

export function reconcileActionCooldown(
    state: ActionState,
    intervalTicks: number,
    tick: number,
): ActionState {
    if (state.cooldownIntervalTicks === null || state.cooldownIntervalTicks === intervalTicks) {
        return state;
    }

    const remaining = Math.max(
        0,
        Math.min(1, (state.readyAtTick - tick) / state.cooldownIntervalTicks),
    );

    return {
        ...state,
        readyAtTick: tick + remaining * intervalTicks,
        cooldownIntervalTicks: intervalTicks,
    };
}

export function beginActionCooldown(
    state: ActionState,
    definition: ActionDefinition,
    intervalTicks: number,
    tick: number,
): ActionState {
    const overdue = tick - state.readyAtTick;
    const anchor = overdue >= 0 && overdue < 1 ? state.readyAtTick : tick;

    return {
        ...state,
        readyAtTick: anchor + intervalTicks,
        recoveryUntilTick: tick + definition.recoveryTicks,
        cooldownIntervalTicks: intervalTicks,
    };
}
