import { assertPositiveNumber, assertPositiveSafeInteger } from "../../core/common/assert.js";
import type { ArknightsMapOptions } from "./map.js";
import type { ArknightsBlackboardEntry } from "./blackboard.js";
import type { PredefinedPrefab } from "./prefab.js";
import type { ArknightsResolvedSkill } from "./skill.js";
import { perSecondToPerTick, secondsToTicks } from "./tick.js";

export interface ArknightsTerrainController {
    readonly profile: Extract<PredefinedPrefab, { readonly type: "MECHANISM" }>;
    readonly skill: ArknightsResolvedSkill;
}

export interface ArknightsTerrainResolution {
    readonly mapOptions: ArknightsMapOptions;
    readonly unappliedBlackboard: readonly {
        readonly controllerIndex: number;
        readonly entry: ArknightsBlackboardEntry;
    }[];
}

export function resolveTerrainControllers(
    controllers: readonly ArknightsTerrainController[],
): ArknightsTerrainResolution {
    const options: {
        mire?: NonNullable<ArknightsMapOptions["mire"]>;
        deepsea?: NonNullable<ArknightsMapOptions["deepsea"]>;
    } = {};
    const unappliedBlackboard: {
        controllerIndex: number;
        entry: ArknightsBlackboardEntry;
    }[] = [];

    for (const [controllerIndex, { profile, skill }] of controllers.entries()) {
        if (skill.prefabKey !== profile.skillPrefabKey) {
            throw new TypeError("controller skill prefab does not match profile");
        }

        const consumed = new Set<string>();

        function parameter(key: string): number {
            const entry = skill.blackboard.find((entry) => entry.key.toLowerCase() === key);

            if (entry?.valueStr !== null) {
                throw new TypeError(`${profile.terrain} requires numeric blackboard ${key}`);
            }

            consumed.add(key);

            return entry.value;
        }

        if (profile.terrain === "MIRE") {
            if (options.mire !== undefined) {
                throw new TypeError("multiple mire controllers are not supported");
            }

            const interval = parameter("value");
            const maxStacks = parameter("max_stack_cnt");

            assertPositiveNumber(interval, "mire stack interval");
            assertPositiveSafeInteger(maxStacks, "mire maximum stacks");

            options.mire = Object.freeze({
                stackIntervalTicks: secondsToTicks(interval, "mire stack interval"),
                attackSpeedPerStack: parameter("attack_speed"),
                moveSpeedRatioPerStack: parameter("move_speed"),
                maxStacks,
            });
        } else {
            if (options.deepsea !== undefined) {
                throw new TypeError("multiple deepsea controllers are not supported");
            }

            const damage = parameter("sea_drown[enemy].damage");
            const speed = parameter("sea_drown[enemy].move_speed");

            if (damage < 0 || speed < 0) {
                throw new RangeError("deepsea damage and speed must be nonnegative");
            }

            options.deepsea = Object.freeze({
                damagePerTick: perSecondToPerTick(damage),
                attackSpeedModifier: parameter("sea_drown[enemy].attack_speed"),
                moveSpeedMultiplier: speed,
            });
        }

        for (const entry of skill.blackboard) {
            if (!consumed.has(entry.key.toLowerCase())) {
                unappliedBlackboard.push(Object.freeze({ controllerIndex, entry }));
            }
        }
    }

    return Object.freeze({
        mapOptions: Object.freeze(options),
        unappliedBlackboard: Object.freeze(unappliedBlackboard),
    });
}
