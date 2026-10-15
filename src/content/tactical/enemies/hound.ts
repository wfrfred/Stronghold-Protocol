import type { Attack } from "../actions/attack.js";
import type { Profile } from "../../../data/arknights/enemy.js";
import type { CombatResources } from "../../../core/tactical/battle/resources.js";
import type { Result as InitializedUnit } from "../../../core/tactical/unit/initialize.js";
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

export type Enemy = InitializedUnit<Definition>;

export function create(
    profile: Profile,
    combat: CombatResources,
    timing: AttackTiming,
): { readonly definition: Definition; readonly action: Attack } {
    if (profile.id !== "enemy_1000_gopro" || profile.applyWay !== "MELEE") {
        throw new TypeError("Hound content requires its melee profile");
    }

    const definition: Definition = {
        ...createGroundDefinition(profile, timing, { type: "BLOCKER" }, combat),
        profile,
        attackTiming: timing,
    };

    return { definition, action: definition.attack };
}
