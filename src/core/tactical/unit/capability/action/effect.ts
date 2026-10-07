import { assertNonnegativeNumber } from "../../../../common/assert.js";
import type { DamageType } from "../vitality/damage/contract.js";

import type { QueryPurpose } from "../../targeting/query.js";

export type EffectDefinition =
    | {
          readonly type: "DAMAGE";
          readonly power: number;
          readonly damageType: DamageType;
          readonly powerSource?: "SOURCE_ATTACK";
      }
    | {
          readonly type: "HEAL";
          readonly power: number;
          readonly ignoreHealFree: boolean;
      };

export function createEffectDefinition(effect: EffectDefinition): EffectDefinition {
    assertNonnegativeNumber(effect.power, "effect power");

    switch (effect.type) {
        case "DAMAGE": {
            const damageType: unknown = effect.damageType;

            if (damageType !== "PHYSICAL" && damageType !== "ARTS" && damageType !== "TRUE") {
                throw new RangeError("unsupported attack damage type");
            }

            const powerSource: unknown = effect.powerSource;

            if (powerSource !== undefined && powerSource !== "SOURCE_ATTACK") {
                throw new RangeError("unsupported damage power source");
            }

            return Object.freeze({
                type: effect.type,
                power: effect.power,
                damageType,
                ...(effect.powerSource === undefined ? {} : { powerSource: effect.powerSource }),
            });
        }

        case "HEAL":
            if (typeof effect.ignoreHealFree !== "boolean") {
                throw new TypeError("ignoreHealFree must be boolean");
            }

            return Object.freeze({ ...effect });
    }
}

export function effectPurposes(effect: EffectDefinition): readonly QueryPurpose[] {
    switch (effect.type) {
        case "DAMAGE":
            return ["DAMAGE"];

        case "HEAL":
            return ["HEAL"];
    }
}
