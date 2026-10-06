export type HeightType =
    | "LOWLAND"
    | "HIGHLAND";

export type BuildableType =
    | "NONE"
    | "MELEE"
    | "ALL"
    | "RANGED";

export type PassableMask =
    | "NONE"
    | "WALK_ONLY"
    | "ALL"
    | "FLY_ONLY";

export type PlayerSideMask =
    | "NONE"
    | "SIDE_A"
    | "SIDE_B"
    | "ALL";

export type TileTerrain =
    | "NORMAL"
    | "HOLE";

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
    readonly terrain: TileTerrain;
    readonly mechanism: TileMechanism | null;
}

function requireFinite(value: number, name: string): number {
    if (!Number.isFinite(value)) {
        throw new RangeError(`${name} must be finite`);
    }
    return value === 0 ? 0 : value;
}

function requireNonnegative(value: number, name: string): number {
    requireFinite(value, name);
    if (value < 0) {
        throw new RangeError(`${name} must be nonnegative`);
    }
    return value === 0 ? 0 : value;
}

function requireTick(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a nonnegative safe integer`);
    }
    return value === 0 ? 0 : value;
}

function copyMechanism(mechanism: TileMechanism | null): TileMechanism | null {
    if (mechanism === null) {
        return null;
    }
    if (typeof mechanism !== "object") {
        throw new TypeError("invalid tile mechanism");
    }

    switch (mechanism.type) {
        case "INFECTION": {
            const params = mechanism.params;
            return Object.freeze({
                type: "INFECTION",
                params: Object.freeze({
                    damagePerTick: requireNonnegative(params.damagePerTick, "infection damage"),
                    attackBonusRatio: requireFinite(params.attackBonusRatio, "infection attack bonus"),
                    attackSpeedBonus: requireFinite(params.attackSpeedBonus, "infection attack speed bonus"),
                    activeUntilTick: requireTick(params.activeUntilTick, "infection expiry tick"),
                }),
            });
        }
        case "MIRE": {
            const params = mechanism.params;
            const stackIntervalTicks = requireTick(params.stackIntervalTicks, "mire stack interval");
            if (stackIntervalTicks === 0) {
                throw new RangeError("mire stack interval must be positive");
            }
            if (!Number.isSafeInteger(params.maxStacks) || params.maxStacks <= 0) {
                throw new RangeError("mire maximum stacks must be a positive safe integer");
            }
            return Object.freeze({
                type: "MIRE",
                params: Object.freeze({
                    stackIntervalTicks,
                    attackSpeedPerStack: requireFinite(params.attackSpeedPerStack, "mire attack speed per stack"),
                    moveSpeedRatioPerStack: requireFinite(params.moveSpeedRatioPerStack, "mire move speed per stack"),
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
                    attackSpeedModifier: requireFinite(params.attackSpeedModifier, "deepsea attack speed modifier"),
                    moveSpeedMultiplier: requireNonnegative(params.moveSpeedMultiplier, "deepsea move speed multiplier"),
                }),
            });
        }
        default:
            throw new TypeError("unsupported tile mechanism");
    }
}

export function createTile(tile: Tile): Tile {
    if (tile === null || typeof tile !== "object") {
        throw new TypeError("invalid tile");
    }
    if (tile.heightType !== "LOWLAND" && tile.heightType !== "HIGHLAND") {
        throw new TypeError("invalid tile height type");
    }
    if (!["NONE", "MELEE", "RANGED", "ALL"].includes(tile.buildableType)) {
        throw new TypeError("invalid tile buildable type");
    }
    if (!["NONE", "WALK_ONLY", "FLY_ONLY", "ALL"].includes(tile.passableMask)) {
        throw new TypeError("invalid tile passable mask");
    }
    if (!["NONE", "SIDE_A", "SIDE_B", "ALL"].includes(tile.playerSideMask)) {
        throw new TypeError("invalid tile player side mask");
    }
    if (!["NORMAL", "HOLE"].includes(tile.terrain)) {
        throw new TypeError("invalid tile terrain");
    }

    return Object.freeze({
        heightType: tile.heightType,
        buildableType: tile.buildableType,
        passableMask: tile.passableMask,
        playerSideMask: tile.playerSideMask,
        terrain: tile.terrain,
        mechanism: copyMechanism(tile.mechanism),
    });
}
