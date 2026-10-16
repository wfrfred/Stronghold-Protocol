import {
    createDefinition as createElementalDefinition,
    type Definition as ElementalDefinition,
    type Type,
} from "../../core/tactical/unit/capability/elemental/capability.js";
import type { Definition as BurstDefinition } from "../../core/tactical/unit/capability/elemental/burst.js";
import { create as createBurstDefinition } from "./elemental-burst.js";
import { secondsToTicks } from "./tick.js";

const elements = { SANITY: "NEURAL", WATER: "EROSION", FIRE: "BURN", DARK: "NECROSIS" } as const;

export type Receiver = "CHARACTER" | "ENEMY";

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
    readonly receiver: Receiver;
    readonly boss?: boolean;
    readonly maxEp?: number;
    readonly recoveryPerSecond?: number;
    readonly elementResistance?: number;
    readonly damageResistance?: number;
    readonly burstRecoverySpeed?: number;
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

const profiles: Readonly<Record<Receiver, Readonly<Record<Type, ArknightsElementalBurstProfile>>>> =
    Object.freeze({
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

function createBursts(receiver: Receiver): Readonly<Record<Type, BurstDefinition>> {
    const selected = profiles[receiver];

    return Object.freeze({
        NEURAL: createBurstDefinition(`elemental/${receiver}/NEURAL`, selected.NEURAL),
        EROSION: createBurstDefinition(`elemental/${receiver}/EROSION`, selected.EROSION),
        BURN: createBurstDefinition(`elemental/${receiver}/BURN`, selected.BURN),
        NECROSIS: createBurstDefinition(`elemental/${receiver}/NECROSIS`, selected.NECROSIS),
    });
}

const bursts = Object.freeze({
    CHARACTER: createBursts("CHARACTER"),
    ENEMY: createBursts("ENEMY"),
});

export function parseElementType(value: unknown): Type {
    for (const [index, key] of Object.keys(elements).entries()) {
        if (value === key || value === index + 1) {
            return elements[key as keyof typeof elements];
        }
    }

    throw new TypeError(`unsupported element type: ${String(value)}`);
}

export function getArknightsElementalBurstProfile(
    receiver: Receiver,
    type: Type,
): ArknightsElementalBurstProfile {
    return profiles[receiver][type];
}

export function createArknightsElementalDefinition(
    options: ArknightsElementalOptions,
): ElementalDefinition {
    return createElementalDefinition({
        maxEp:
            options.maxEp ?? (options.receiver === "ENEMY" && options.boss === true ? 2000 : 1000),
        recoveryPerSecond: options.recoveryPerSecond ?? 0,
        elementResistance: options.elementResistance ?? 0,
        damageResistance: options.damageResistance ?? 0,
        burstRecoverySpeed: options.burstRecoverySpeed ?? 1,
        bursts: bursts[options.receiver],
    });
}
