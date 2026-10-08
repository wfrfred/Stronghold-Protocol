import {
    assertFiniteNumber,
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
    assertPositiveSafeInteger,
} from "../../../common/assert.js";

export type HeightType = "LOWLAND" | "HIGHLAND";

export type BuildableType = "NONE" | "MELEE" | "ALL" | "RANGED";

export type PassableMask = "NONE" | "WALK_ONLY" | "ALL" | "FLY_ONLY";

export type PlayerSideMask = "NONE" | "SIDE_A" | "SIDE_B" | "ALL";

export type TileTerrain = "NORMAL" | "HOLE";

export interface InfectionParams {
    readonly damagePerTick: number;
    readonly attackBonusRatio: number;
    readonly attackSpeedBonus: number;
    readonly activeUntilTick: number;
}

export interface MireParams {
    readonly stackIntervalTicks: number;
    readonly attackSpeedPerStack: number;
    readonly moveSpeedRatioPerStack: number;
    readonly maxStacks: number;
}

export interface DeepseaParams {
    readonly damagePerTick: number;
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
    readonly playerSideMask: PlayerSideMask;
    readonly advancedBuildableMask?: number;
    readonly terrain: TileTerrain;
    readonly mechanism: TileMechanism | null;
}

function requireFinite(value: number, name: string): number {
    assertFiniteNumber(value, name);

    return value === 0 ? 0 : value;
}

function requireNonnegative(value: number, name: string): number {
    assertNonnegativeNumber(value, name);

    return value === 0 ? 0 : value;
}

function requireTick(value: number, name: string): number {
    assertNonnegativeSafeInteger(value, name);

    return value === 0 ? 0 : value;
}

function copyMechanism(mechanism: TileMechanism | null): TileMechanism | null {
    if (mechanism === null) {
        return null;
    }
    switch (mechanism.type) {
        case "INFECTION": {
            const params = mechanism.params;

            return Object.freeze({
                type: "INFECTION",
                params: Object.freeze({
                    damagePerTick: requireNonnegative(params.damagePerTick, "infection damage"),
                    attackBonusRatio: requireFinite(
                        params.attackBonusRatio,
                        "infection attack bonus",
                    ),
                    attackSpeedBonus: requireFinite(
                        params.attackSpeedBonus,
                        "infection attack speed bonus",
                    ),
                    activeUntilTick: requireTick(params.activeUntilTick, "infection expiry tick"),
                }),
            });
        }

        case "MIRE": {
            const params = mechanism.params;
            const stackIntervalTicks = params.stackIntervalTicks;

            assertPositiveSafeInteger(stackIntervalTicks, "mire stack interval");
            assertPositiveSafeInteger(params.maxStacks, "mire maximum stacks");

            return Object.freeze({
                type: "MIRE",
                params: Object.freeze({
                    stackIntervalTicks,
                    attackSpeedPerStack: requireFinite(
                        params.attackSpeedPerStack,
                        "mire attack speed per stack",
                    ),
                    moveSpeedRatioPerStack: requireFinite(
                        params.moveSpeedRatioPerStack,
                        "mire move speed per stack",
                    ),
                    maxStacks: params.maxStacks,
                }),
            });
        }

        case "SMOG":
            return Object.freeze({ type: "SMOG" });

        case "DEEPSEA": {
            const params = mechanism.params;

            return Object.freeze({
                type: "DEEPSEA",
                params: Object.freeze({
                    damagePerTick: requireNonnegative(params.damagePerTick, "deepsea damage"),
                    attackSpeedModifier: requireFinite(
                        params.attackSpeedModifier,
                        "deepsea attack speed modifier",
                    ),
                    moveSpeedMultiplier: requireNonnegative(
                        params.moveSpeedMultiplier,
                        "deepsea move speed multiplier",
                    ),
                }),
            });
        }
    }
}

export function createTile(tile: Tile): Tile {
    const advancedBuildableMask = tile.advancedBuildableMask ?? 0;

    if (
        !Number.isSafeInteger(advancedBuildableMask) ||
        advancedBuildableMask < 0 ||
        advancedBuildableMask > 0xffff_ffff
    ) {
        throw new RangeError("invalid advanced buildable mask");
    }

    return Object.freeze({
        heightType: tile.heightType,
        buildableType: tile.buildableType,
        passableMask: tile.passableMask,
        playerSideMask: tile.playerSideMask,
        advancedBuildableMask,
        terrain: tile.terrain,
        mechanism: copyMechanism(tile.mechanism),
    });
}
