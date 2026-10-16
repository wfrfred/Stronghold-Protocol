import type { Attack } from "../actions/attack.js";
import type { Profile } from "../../../data/arknights/enemy.js";
import type { Unit } from "../../../core/tactical/unit/unit.js";
import type { Product } from "../../../core/tactical/unit/capability/catalog.js";
import {
    createDefinition as createGroundDefinition,
    type AttackTiming,
    type Definition as GroundDefinition,
} from "./ground.js";

export type { AttackTiming } from "./ground.js";

export interface Definition extends GroundDefinition {
    readonly profile: Profile;
    readonly attackTiming: AttackTiming;
}

export type Enemy = Unit & Product<Definition>;

export function create(
    profile: Profile,
    timing: AttackTiming,
): { readonly definition: Definition; readonly action: Attack } {
    if (profile.id !== "enemy_1000_gopro" || profile.applyWay !== "MELEE") {
        throw new TypeError("Hound content requires its melee profile");
    }

    const definition: Definition = {
        ...createGroundDefinition(profile, timing, { type: "BLOCKER" }),
        profile,
        attackTiming: timing,
    };

    return { definition, action: definition.attack };
}
