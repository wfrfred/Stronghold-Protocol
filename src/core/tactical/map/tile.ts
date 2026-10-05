export type HeightType =
    | "LOWLAND"
    | "HIGHLAND";

export type BuildableType =
    | "NONE"
    | "ALL"
    | "RANGED";

export type PassableMask =
    | "NONE"
    | "ALL"
    | "FLY_ONLY";

export interface InfectionParams {
    readonly damagePerSecond: number;
    readonly attackBonusRatio: number;
    readonly attackSpeedBonus: number;
    readonly activeUntilSeconds: number;
}

export interface MireParams {
    readonly stackIntervalSeconds: number;
    readonly attackSpeedPerStack: number;
    readonly moveSpeedRatioPerStack: number;
    readonly maxStacks: number;
}

export interface DeepseaParams {
    readonly damagePerSecond: number;
    readonly attackSpeedModifier: number;
    readonly moveSpeedMultiplier: number;
}

export type TileMechanism =
    | {
        readonly type: "INFECTION";
        readonly params: InfectionParams;
    }
    | {
        readonly type: "MIRE";
        readonly params: MireParams;
    }
    | {
        readonly type: "SMOG";
    }
    | {
        readonly type: "DEEPSEA";
        readonly params: DeepseaParams;
    };

export interface Tile {
    readonly heightType: HeightType;
    readonly buildableType: BuildableType;
    readonly passableMask: PassableMask;
    readonly mechanism: TileMechanism | null;
}
