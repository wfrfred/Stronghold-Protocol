import type { Unit } from "../../unit.js";
import { hasAllegiance } from "../allegiance.js";
import { isSpatiallyPresent } from "../presence.js";
import { hasVitality } from "../vitality/capability.js";
import { ELEMENT_TYPES, hasElemental, type ElementType } from "./capability.js";

export type ElementalRejection = "NO_ELEMENTAL" | "INACTIVE" | "NEUTRAL" | "RECOVERING" | "IMMUNE";

export function elementalRejection(unit: Unit): ElementalRejection | undefined {
    if (!hasElemental(unit)) {
        return "NO_ELEMENTAL";
    }
    if (!isSpatiallyPresent(unit) || (hasVitality(unit) && unit.vitality.hp <= 0)) {
        return "INACTIVE";
    }
    if (hasAllegiance(unit) && unit.allegiance.side === "NEUTRAL") {
        return "NEUTRAL";
    }
    if (unit.elemental.recovery !== null) {
        return "RECOVERING";
    }

    if (unit.elemental.immune) {
        return "IMMUNE";
    }

    return undefined;
}

export function canReceiveElementDamage(unit: Unit): boolean {
    return elementalRejection(unit) === undefined;
}

export function canReceiveElementHeal(unit: Unit): boolean {
    return elementalRejection(unit) === undefined;
}

export function getCurrentElementType(unit: Unit): ElementType | undefined {
    if (!hasElemental(unit)) {
        return undefined;
    }

    let selected: ElementType | undefined;
    let minimum = unit.definition.elemental.maxEp;

    for (const type of ELEMENT_TYPES) {
        if (unit.elemental.ep[type] < minimum) {
            selected = type;
            minimum = unit.elemental.ep[type];
        }
    }

    return selected;
}

export function elementDamageRatio(unit: Unit): number {
    const type = getCurrentElementType(unit);

    if (type === undefined || !hasElemental(unit)) {
        return 0;
    }

    return 1 - unit.elemental.ep[type] / unit.definition.elemental.maxEp;
}
