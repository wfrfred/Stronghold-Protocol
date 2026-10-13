import type { Profile } from "../../../data/arknights/enemy.js";
import type { CombatResources } from "../../../core/tactical/battle/resources.js";
import { compileAction } from "../../../core/tactical/unit/capability/action/compile.js";
import type { CompiledAction } from "../../../core/tactical/unit/capability/action/compiled.js";
import type { Result as InitializedUnit } from "../../../core/tactical/unit/initialize.js";
import { withTiming } from "./attack.js";
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
): { readonly definition: Definition; readonly action: CompiledAction } {
    if (profile.id !== "enemy_1000_gopro" || profile.applyWay !== "MELEE") {
        throw new TypeError("Hound content requires its melee profile");
    }

    const definition: Definition = {
        ...createGroundDefinition(profile, timing, { type: "BLOCKER" }),
        profile,
        attackTiming: timing,
    };
    const action = compileAction(definition.action.normalAction, combat);

    return { definition, action: withTiming(action, timing, action.program) };
}
