import {
    assertFiniteNumber,
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
    assertPositiveNumber,
    assertPositiveSafeInteger,
} from "../../../../common/assert.js";
import {
    widenUnit,
    type StableUnit,
    type Unit,
    type UnitDefinition,
    type UnitId,
} from "../../unit.js";

export const ELEMENT_TYPES = Object.freeze(["NEURAL", "EROSION", "BURN", "NECROSIS"] as const);

export type ElementType = (typeof ELEMENT_TYPES)[number];

export type ElementalReceiver = "CHARACTER" | "ENEMY";

export type ElementValues = Readonly<Record<ElementType, number>>;

export interface ElementalDefinition {
    readonly receiver: ElementalReceiver;
    readonly maxEp: number;
    readonly recoveryPerTick: number;
    readonly elementResistance: number;
    readonly damageResistance: number;
    readonly burstDurationsTicks: ElementValues;
    readonly immune: boolean;
}

export interface ElementalRecovery {
    readonly type: ElementType;
    readonly sourceUnitId: UnitId | null;
    readonly startedAtTick: number;
    readonly endsAtTick: number;
}

export interface ElementalState {
    readonly ep: ElementValues;
    readonly immune: boolean;
    readonly recovery: ElementalRecovery | null;
    readonly lastRecoveryTick: number;
}

export interface Elemental {
    readonly elemental: ElementalState;
}

export interface ElementalUnitDefinition extends UnitDefinition {
    readonly elemental: ElementalDefinition;
}

export type ElementalUnit<D extends ElementalUnitDefinition = ElementalUnitDefinition> = Unit<D> &
    Elemental;

export function hasElemental<U extends Unit>(
    unit: U,
): unit is U & ElementalUnit<U["definition"] & ElementalUnitDefinition> {
    return "elemental" in unit && "elemental" in unit.definition;
}

export function hasElementalDefinition(
    definition: UnitDefinition,
): definition is ElementalUnitDefinition {
    return "elemental" in definition;
}

export function elementValues(value: number): ElementValues {
    return Object.freeze({ NEURAL: value, EROSION: value, BURN: value, NECROSIS: value });
}

export function createElementalDefinition(
    definition: Omit<
        ElementalDefinition,
        "recoveryPerTick" | "elementResistance" | "damageResistance" | "immune"
    > &
        Partial<
            Pick<
                ElementalDefinition,
                "recoveryPerTick" | "elementResistance" | "damageResistance" | "immune"
            >
        >,
): ElementalDefinition {
    const { recoveryPerTick = 0, elementResistance = 0, damageResistance = 0 } = definition;

    assertPositiveNumber(definition.maxEp, "maximum EP");
    assertNonnegativeNumber(recoveryPerTick, "EP recovery per tick");
    assertFiniteNumber(elementResistance, "element resistance");
    assertFiniteNumber(damageResistance, "element HP damage resistance");

    for (const type of ELEMENT_TYPES) {
        assertPositiveSafeInteger(definition.burstDurationsTicks[type], "element burst duration");
    }

    return Object.freeze({
        receiver: definition.receiver,
        maxEp: definition.maxEp,
        recoveryPerTick,
        elementResistance,
        damageResistance,
        burstDurationsTicks: Object.freeze({ ...definition.burstDurationsTicks }),
        immune: definition.immune ?? false,
    });
}

export function initializeElementalState(
    definition: ElementalDefinition,
    context: { readonly tick: number } = { tick: 0 },
): ElementalState {
    assertNonnegativeSafeInteger(context.tick, "elemental initialization tick");

    return {
        ep: elementValues(definition.maxEp),
        immune: definition.immune,
        recovery: null,
        lastRecoveryTick: context.tick,
    };
}

export function setElementalImmunity<U extends Unit>(
    input: U | StableUnit<U>,
    immune: boolean,
): StableUnit<U> {
    const unit = widenUnit<U>(input);

    if (!hasElemental(unit)) {
        throw new TypeError("element immunity requires Elemental capability");
    }
    if (unit.elemental.immune === immune) {
        return unit;
    }

    return { ...unit, elemental: { ...unit.elemental, immune } };
}
