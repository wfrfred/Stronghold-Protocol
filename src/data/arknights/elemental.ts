import {
    createElementalDefinition,
    type ElementalDefinition,
    type ElementalReceiver,
    type ElementType,
} from "../../core/tactical/unit/capability/elemental/capability.js";
import { perSecondToPerTick, secondsToTicks } from "./tick.js";

const elements = { SANITY: "NEURAL", WATER: "EROSION", FIRE: "BURN", DARK: "NECROSIS" } as const;

export interface ArknightsElementalBurstProfile {
    readonly durationTicks: number;
    readonly burstDamage: {
        readonly type: "PHYSICAL" | "ARTS" | "TRUE" | "ELEMENTAL";
        readonly power: number;
    } | null;
    readonly damagePerSecond: {
        readonly type: "ARTS" | "ELEMENTAL";
        readonly power: number;
    } | null;
    readonly defReduction: number;
    readonly resReduction: number;
    readonly stunTicks: number;
    readonly paralysisStacks: number;
    readonly spDrainPerSecond: number;
    readonly blocksSkill: boolean;
    readonly blocksSpRecovery: boolean;
    readonly attackReductionRatio: number;
}

export interface ArknightsElementalOptions {
    readonly receiver: ElementalReceiver;
    readonly boss?: boolean;
    readonly maxEp?: number;
    readonly recoveryPerSecond?: number;
    readonly elementResistance?: number;
    readonly damageResistance?: number;
    readonly immune?: boolean;
}

function profile(
    input: Partial<ArknightsElementalBurstProfile> &
        Pick<ArknightsElementalBurstProfile, "durationTicks">,
): ArknightsElementalBurstProfile {
    return Object.freeze({
        burstDamage: null,
        damagePerSecond: null,
        defReduction: 0,
        resReduction: 0,
        stunTicks: 0,
        paralysisStacks: 0,
        spDrainPerSecond: 0,
        blocksSkill: false,
        blocksSpRecovery: false,
        attackReductionRatio: 0,
        ...input,
        ...(input.burstDamage == null
            ? {}
            : { burstDamage: Object.freeze({ ...input.burstDamage }) }),
        ...(input.damagePerSecond == null
            ? {}
            : { damagePerSecond: Object.freeze({ ...input.damagePerSecond }) }),
    });
}

const profiles: Readonly<
    Record<ElementalReceiver, Readonly<Record<ElementType, ArknightsElementalBurstProfile>>>
> = Object.freeze({
    CHARACTER: Object.freeze({
        NEURAL: profile({
            durationTicks: secondsToTicks(10),
            burstDamage: { type: "TRUE", power: 1000 },
            stunTicks: secondsToTicks(10),
        }),
        EROSION: profile({
            durationTicks: secondsToTicks(10),
            burstDamage: { type: "PHYSICAL", power: 800 },
            defReduction: 100,
        }),
        BURN: profile({
            durationTicks: secondsToTicks(10),
            burstDamage: { type: "ARTS", power: 1200 },
            resReduction: 20,
        }),
        NECROSIS: profile({
            durationTicks: secondsToTicks(15),
            damagePerSecond: { type: "ARTS", power: 100 },
            spDrainPerSecond: 1,
            blocksSkill: true,
            blocksSpRecovery: true,
        }),
    }),
    ENEMY: Object.freeze({
        NEURAL: profile({
            durationTicks: secondsToTicks(10),
            burstDamage: { type: "ELEMENTAL", power: 6000 },
            paralysisStacks: 3,
        }),
        EROSION: profile({
            durationTicks: secondsToTicks(8),
            burstDamage: { type: "ELEMENTAL", power: 5000 },
            defReduction: 120,
        }),
        BURN: profile({
            durationTicks: secondsToTicks(10),
            burstDamage: { type: "ELEMENTAL", power: 7000 },
            resReduction: 20,
        }),
        NECROSIS: profile({
            durationTicks: secondsToTicks(15),
            damagePerSecond: { type: "ELEMENTAL", power: 800 },
            attackReductionRatio: 0.5,
        }),
    }),
});

export function parseElementType(value: unknown): ElementType {
    for (const [index, key] of Object.keys(elements).entries()) {
        if (value === key || value === index + 1) {
            return elements[key as keyof typeof elements];
        }
    }

    throw new TypeError(`unsupported element type: ${String(value)}`);
}

export function getArknightsElementalBurstProfile(
    receiver: ElementalReceiver,
    type: ElementType,
): ArknightsElementalBurstProfile {
    return profiles[receiver][type];
}

export function createArknightsElementalDefinition(
    options: ArknightsElementalOptions,
): ElementalDefinition {
    const selected = profiles[options.receiver];

    return createElementalDefinition({
        receiver: options.receiver,
        maxEp:
            options.maxEp ?? (options.receiver === "ENEMY" && options.boss === true ? 2000 : 1000),
        recoveryPerTick: perSecondToPerTick(options.recoveryPerSecond ?? 0),
        elementResistance: options.elementResistance ?? 0,
        damageResistance: options.damageResistance ?? 0,
        immune: options.immune ?? false,
        burstDurationsTicks: {
            NEURAL: selected.NEURAL.durationTicks,
            EROSION: selected.EROSION.durationTicks,
            BURN: selected.BURN.durationTicks,
            NECROSIS: selected.NECROSIS.durationTicks,
        },
    });
}
