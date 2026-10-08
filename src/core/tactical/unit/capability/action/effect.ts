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

    return Object.freeze({ ...effect });
}

export function effectPurposes(effect: EffectDefinition): readonly QueryPurpose[] {
    switch (effect.type) {
        case "DAMAGE":
            return ["DAMAGE"];

        case "HEAL":
            return ["HEAL"];
    }
}
