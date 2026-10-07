import type { HealingRequest } from "../../core/tactical/unit/capability/vitality/healing/contract.js";

export function readArknightsHealingRequest(
    value: unknown,
    input: Pick<HealingRequest, "sourceUnitId" | "targetUnitId" | "power">,
): HealingRequest {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("healing action must be an object");
    }

    const source = value as Record<string, unknown>;

    if (source.$type !== "Torappu.Battle.Action.Nodes+HealViaMaxHpRatio") {
        throw new TypeError("unsupported healing action");
    }
    if (typeof source._ignoreHealFree !== "boolean") {
        throw new TypeError("healing action _ignoreHealFree must be boolean");
    }
    if (typeof source._skipModifierEvent !== "boolean") {
        throw new TypeError("healing action _skipModifierEvent must be boolean");
    }

    return Object.freeze({
        sourceUnitId: input.sourceUnitId,
        targetUnitId: input.targetUnitId,
        power: input.power,
        ignoreHealFree: source._ignoreHealFree || source._skipModifierEvent,
        skipModifierEvents: source._skipModifierEvent,
    });
}
