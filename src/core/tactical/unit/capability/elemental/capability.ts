import {
    assertFiniteNumber,
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
    assertPositiveNumber,
    assertPositiveSafeInteger,
} from "../../../../common/assert.js";
import type { Unit, Definition as UnitDefinition, Id } from "../../unit.js";

export const ELEMENT_TYPES = Object.freeze(["NEURAL", "EROSION", "BURN", "NECROSIS"] as const);

export type ElementType = (typeof ELEMENT_TYPES)[number];

export type ElementalReceiver = "CHARACTER" | "ENEMY";

export type ElementValues = Readonly<Record<ElementType, number>>;

export interface Definition {
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
    readonly sourceUnitId: Id | null;
    readonly startedAtTick: number;
    readonly endsAtTick: number;
}

export interface State {
    readonly ep: ElementValues;
    readonly immune: boolean;
    readonly recovery: ElementalRecovery | null;
    readonly lastRecoveryTick: number;
}

export interface Elemental {
    readonly definition: { readonly elemental: Definition };
    readonly elemental: State;
}

export function hasElemental<U extends Unit>(unit: U): unit is U & Elemental {
    return "elemental" in unit && "elemental" in unit.definition;
}

export function hasElementalDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Elemental["definition"] {
    return "elemental" in definition;
}

export function elementValues(value: number): ElementValues {
    return Object.freeze({ NEURAL: value, EROSION: value, BURN: value, NECROSIS: value });
}

export function createDefinition(
    definition: Omit<
        Definition,
        "recoveryPerTick" | "elementResistance" | "damageResistance" | "immune"
    > &
        Partial<
            Pick<
                Definition,
                "recoveryPerTick" | "elementResistance" | "damageResistance" | "immune"
            >
        >,
): Definition {
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

export function initialize(
    definition: Definition,
    context: { readonly tick: number } = { tick: 0 },
): State {
    assertNonnegativeSafeInteger(context.tick, "elemental initialization tick");

    return {
        ep: elementValues(definition.maxEp),
        immune: definition.immune,
        recovery: null,
        lastRecoveryTick: context.tick,
    };
}

export function setElementalImmunity(state: State, immune: boolean): State {
    return state.immune === immune ? state : { ...state, immune };
}
