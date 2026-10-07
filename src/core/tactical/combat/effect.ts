export type DamageType = "PHYSICAL" | "ARTS" | "TRUE";

export type QueryPurpose = "DAMAGE" | "HEAL" | "ELEMENT_DAMAGE" | "ELEMENT_HEAL";

export type EffectDefinition =
    | {
          readonly type: "DAMAGE";
          readonly power: number;
          readonly damageType: DamageType;
      }
    | {
          readonly type: "HEAL";
          readonly power: number;
          readonly ignoreHealFree: boolean;
      };

export function createEffectDefinition(effect: EffectDefinition): EffectDefinition {
    if (!Number.isFinite(effect.power) || effect.power < 0) {
        throw new RangeError("effect power must be finite and nonnegative");
    }

    switch (effect.type) {
        case "DAMAGE": {
            const damageType: unknown = effect.damageType;

            if (damageType !== "PHYSICAL" && damageType !== "ARTS" && damageType !== "TRUE") {
                throw new RangeError("unsupported attack damage type");
            }

            return Object.freeze({ type: effect.type, power: effect.power, damageType });
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
