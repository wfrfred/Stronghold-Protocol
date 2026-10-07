import { createEffectDefinition, type EffectDefinition } from "../../combat/effect.js";
import {
    createTargetingDefinition,
    type TargetingDefinition,
} from "../../combat/targeting-definition.js";
import type { Unit, UnitDefinition, UnitId } from "../unit.js";

export type TargetBindingId = string;

export interface ActionTargetGroupDefinition {
    readonly id: TargetBindingId;
    readonly targeting: TargetingDefinition;
    readonly effects: readonly [EffectDefinition, ...EffectDefinition[]];
}

export type EffectReceiver =
    { readonly type: "SOURCE" } | { readonly type: "BINDING"; readonly bindingId: TargetBindingId };

export interface FollowUpEffectDefinition {
    readonly receiver: EffectReceiver;
    readonly effect: EffectDefinition;
}

export interface ActionDefinition {
    readonly triggerBindingId: TargetBindingId;
    readonly targetGroups: readonly [ActionTargetGroupDefinition, ...ActionTargetGroupDefinition[]];
    readonly followUps: readonly FollowUpEffectDefinition[];
    readonly intervalTicks: number;
    readonly recoveryTicks: number;
}

export interface ActionCapabilityDefinition {
    readonly normalAction: ActionDefinition;
}

export interface ActionState {
    readonly readyAtTick: number;
    readonly recoveryUntilTick: number;
    readonly targetUnitId: UnitId | null;
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

function ticks(value: number, minimum: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new RangeError(`${name} must be a safe integer of at least ${minimum}`);
    }

    return value;
}

export function createActionDefinition(definition: ActionDefinition): ActionDefinition {
    const groupsAreArray: boolean = Array.isArray(definition.targetGroups);

    if (!groupsAreArray || definition.targetGroups.length === 0) {
        throw new RangeError("action must have at least one target group");
    }

    const ids = new Set<TargetBindingId>();
    const targetGroups = Array.from(definition.targetGroups, (group) => {
        if (typeof group.id !== "string" || group.id.length === 0 || ids.has(group.id)) {
            throw new RangeError("action target binding IDs must be unique and nonempty");
        }

        const effectsAreArray: boolean = Array.isArray(group.effects);

        if (!effectsAreArray || group.effects.length === 0) {
            throw new RangeError("target group must have at least one effect");
        }

        ids.add(group.id);

        return Object.freeze({
            id: group.id,
            targeting: createTargetingDefinition(group.targeting),
            effects: Object.freeze(Array.from(group.effects, createEffectDefinition)) as readonly [
                EffectDefinition,
                ...EffectDefinition[],
            ],
        });
    });
    const followUps = Array.from(definition.followUps, ({ receiver, effect }) => {
        const receiverType: unknown = receiver.type;

        if (receiverType !== "SOURCE" && receiverType !== "BINDING") {
            throw new RangeError("unsupported effect receiver");
        }
        if (receiver.type === "BINDING" && !ids.has(receiver.bindingId)) {
            throw new RangeError("follow-up references an unknown target binding");
        }

        return Object.freeze({
            receiver: Object.freeze({ ...receiver }),
            effect: createEffectDefinition(effect),
        });
    });

    if (!ids.has(definition.triggerBindingId)) {
        throw new RangeError("action trigger references an unknown target binding");
    }

    return Object.freeze({
        triggerBindingId: definition.triggerBindingId,
        targetGroups: Object.freeze(targetGroups) as ActionDefinition["targetGroups"],
        followUps: Object.freeze(followUps),
        intervalTicks: ticks(definition.intervalTicks, 1, "action intervalTicks"),
        recoveryTicks: ticks(definition.recoveryTicks, 0, "action recoveryTicks"),
    });
}

export function createActionCapabilityDefinition(
    definition: ActionCapabilityDefinition,
): ActionCapabilityDefinition {
    return Object.freeze({ normalAction: createActionDefinition(definition.normalAction) });
}

export function createActionState(tick = 0): ActionState {
    ticks(tick, 0, "action tick");

    return { readyAtTick: tick, recoveryUntilTick: tick, targetUnitId: null };
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
