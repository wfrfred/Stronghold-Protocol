import { damage as damageFilter, healing as healingFilter } from "../../dist/core/tactical/battle/targeting/filter.js";
import * as filters from "../../dist/core/tactical/battle/targeting/filter.js";
import * as compare from "../../dist/core/tactical/battle/targeting/compare.js";
import { first } from "../../dist/core/tactical/battle/targeting/selector.js";
import { allowsRestrictions } from "../../dist/core/tactical/unit/capability/targetable/capability.js";
import { invisibilityKind, untargetableKind, allyUntargetableKind } from "../../dist/content/tactical/effects/visibility.js";
import { invincibilityKind, healFreeKind } from "../../dist/content/tactical/effects/protection.js";

export function damage({ geometry, scope, canTargetAir = false, maxTargets = 1,
    includeBlockingRelations = false, preferBlockingRelations = false,
    ignoreInvisible = false, ignoreTargetFree = false, purposes = ["DAMAGE"],
} = {}) {
    const eligible = ignoreInvisible || ignoreTargetFree
        ? filters.and(filters.present, filters.alive, filters.hostile, (battle, request, target) =>
            allowsRestrictions(battle, request, target, kind =>
                (ignoreInvisible && kind === invisibilityKind) ||
                (ignoreTargetFree && [invisibilityKind, untargetableKind, invincibilityKind].includes(kind))))
        : damageFilter;
    const spatial = scope?.type === "BLOCKER" ? filters.blocker
        : includeBlockingRelations ? filters.or(filters.range(geometry ?? scope.geometry), filters.blocking)
        : filters.range(geometry ?? scope.geometry);
    return {
        purposes,
        filter: filters.and(eligible, ...(canTargetAir ? [] : [filters.ground]), spatial),
        selector: first(maxTargets, preferBlockingRelations
            ? compare.combine(compare.blockedFirst, compare.distance) : compare.distance),
    };
}

export function healing({ geometry, maxTargets = 1, includeSelf = false,
    ignoreAllyTargetFree = false, ignoreHealFree = false, purposes = ["HEAL"],
} = {}) {
    const eligible = ignoreAllyTargetFree || ignoreHealFree
        ? filters.and(filters.present, filters.alive, filters.sameSide, filters.missingHp, (battle, request, target) =>
            allowsRestrictions(battle, request, target, kind =>
                (ignoreAllyTargetFree && kind === allyUntargetableKind) ||
                (ignoreHealFree && kind === healFreeKind)))
        : healingFilter;
    return {
        purposes,
        filter: filters.and(eligible, filters.range(geometry),
            (_battle, request, target) => includeSelf || request.source.id !== target.id),
        selector: first(maxTargets, compare.hpRatio),
    };
}
