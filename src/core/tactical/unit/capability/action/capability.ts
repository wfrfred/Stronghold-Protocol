import {
    assertNonnegativeSafeInteger,
    assertPositiveSafeInteger,
} from "../../../../common/assert.js";
import * as operation from "./operation.js";
import { createTargetingDefinition, type TargetingDefinition } from "../../targeting/definition.js";
import type { Unit, UnitDefinition } from "../../unit.js";

export type TargetBindingId = string;

export interface ActionTargetGroupDefinition {
    readonly id: TargetBindingId;
    readonly targeting: TargetingDefinition;
    readonly operations: readonly [operation.Definition, ...operation.Definition[]];
}

export type OperationReceiver =
    { readonly type: "SOURCE" } | { readonly type: "BINDING"; readonly bindingId: TargetBindingId };

export interface FollowUpOperationDefinition {
    readonly receiver: OperationReceiver;
    readonly operation: operation.Definition;
}

export interface ActionDefinition {
    readonly triggerBindingId: TargetBindingId;
    readonly targetGroups: readonly [ActionTargetGroupDefinition, ...ActionTargetGroupDefinition[]];
    readonly followUps: readonly FollowUpOperationDefinition[];
    readonly intervalTicks: number;
    readonly recoveryTicks: number;
}

export interface ActionCapabilityDefinition {
    readonly normalAction: ActionDefinition;
}

export interface ActionState {
    readonly readyAtTick: number;
    readonly recoveryUntilTick: number;
}

export interface Action {
    readonly action: ActionState;
}

export interface ActingUnitDefinition extends UnitDefinition {
    readonly action: ActionCapabilityDefinition;
}

export function hasAction<U extends Unit>(
    unit: U,
): unit is U & Action & Unit<U["definition"] & ActingUnitDefinition> {
    return "action" in unit && "action" in unit.definition;
}

export function hasActionDefinition(
    definition: UnitDefinition,
): definition is ActingUnitDefinition {
    return "action" in definition;
}

export function createActionDefinition(definition: ActionDefinition): ActionDefinition {
    const ids = new Set<TargetBindingId>();
    const targetGroups = Array.from(definition.targetGroups, (group) => {
        if (group.id.length === 0 || ids.has(group.id)) {
            throw new RangeError("action target binding IDs must be unique and nonempty");
        }

        ids.add(group.id);

        return Object.freeze({
            id: group.id,
            targeting: createTargetingDefinition(group.targeting),
            operations: Object.freeze(Array.from(group.operations, operation.create)) as readonly [
                operation.Definition,
                ...operation.Definition[],
            ],
        });
    });
    const followUps = Array.from(definition.followUps, ({ receiver, operation: followUp }) => {
        if (receiver.type === "BINDING" && !ids.has(receiver.bindingId)) {
            throw new RangeError("follow-up references an unknown target binding");
        }

        return Object.freeze({
            receiver: Object.freeze({ ...receiver }),
            operation: operation.create(followUp),
        });
    });

    if (!ids.has(definition.triggerBindingId)) {
        throw new RangeError("action trigger references an unknown target binding");
    }

    assertPositiveSafeInteger(definition.intervalTicks, "action intervalTicks");
    assertNonnegativeSafeInteger(definition.recoveryTicks, "action recoveryTicks");

    return Object.freeze({
        triggerBindingId: definition.triggerBindingId,
        targetGroups: Object.freeze(targetGroups) as ActionDefinition["targetGroups"],
        followUps: Object.freeze(followUps),
        intervalTicks: definition.intervalTicks,
        recoveryTicks: definition.recoveryTicks,
    });
}

export function createActionCapabilityDefinition(
    definition: ActionCapabilityDefinition,
): ActionCapabilityDefinition {
    return Object.freeze({ normalAction: createActionDefinition(definition.normalAction) });
}

export function createActionState(tick = 0): ActionState {
    assertNonnegativeSafeInteger(tick, "action tick");

    return { readyAtTick: tick, recoveryUntilTick: tick };
}

export function initializeActionState(
    _definition: ActionCapabilityDefinition,
    context: { readonly tick: number },
): ActionState {
    return createActionState(context.tick);
}

export function copyActionState(state: Readonly<ActionState>): ActionState {
    return { ...state };
}
