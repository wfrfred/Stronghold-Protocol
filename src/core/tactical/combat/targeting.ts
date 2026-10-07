import type { BattlefieldView } from "../battlefield/contract.js";
import { World } from "../geometry/coordinate.js";
import { rangeOverlapsHit } from "../geometry/intersection.js";
import type { CompiledTargeting, TargetQueryContext } from "../targeting/query.js";
import { areHostile, hasAllegiance } from "../unit/capability/allegiance.js";
import { isSpatiallyPresent } from "../unit/capability/presence.js";
import { hasHit, hasSpatial } from "../unit/capability/spatial.js";
import { hasStatusFlag } from "../unit/capability/status.js";
import { hasVitality, type VitalUnit } from "../unit/capability/vitality.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { QueryPurpose } from "./effect.js";
import type {
    DamageTargetingDefinition,
    HealingTargetingDefinition,
    TargetingDefinition,
} from "./targeting-definition.js";

export type CombatTargetingView = Pick<
    BattlefieldView,
    "unitIds" | "getUnit" | "blockerOf" | "blockedBy"
>;

export interface CombatTargetQueryContext extends TargetQueryContext {
    readonly source: Unit;
    readonly battlefield: CombatTargetingView;
}

export type HealingMaxHpProvider = (unit: VitalUnit, context: CombatTargetQueryContext) => number;

const staticMaxHp: HealingMaxHpProvider = (unit) => unit.definition.vitality.maxHp;

function isActiveVitalUnit(target: Unit): target is VitalUnit {
    return hasVitality(target) && target.vitality.hp > 0 && isSpatiallyPresent(target);
}

function sameSide(source: Unit, target: Unit): boolean {
    return (
        hasAllegiance(source) &&
        hasAllegiance(target) &&
        source.allegiance.side === target.allegiance.side
    );
}

function blockingRelated(context: CombatTargetQueryContext, targetId: UnitId): boolean {
    const { source, battlefield } = context;

    return (
        battlefield.blockerOf(source.id) === targetId ||
        battlefield.blockedBy(source.id).includes(targetId)
    );
}

function acceptsHostileStatus(target: Unit, definition: DamageTargetingDefinition): boolean {
    if (hasStatusFlag(target, "CAMOUFLAGE")) {
        return false;
    }
    if (definition.ignoreTargetFree) {
        return true;
    }
    if (hasStatusFlag(target, "TARGET_FREE") || hasStatusFlag(target, "INVINCIBLE")) {
        return false;
    }

    return definition.ignoreInvisible || !hasStatusFlag(target, "INVISIBLE");
}

function compareDistance(context: CombatTargetQueryContext, left: Unit, right: Unit): number {
    return (
        World.distanceSquared(context.source.position, left.position) -
        World.distanceSquared(context.source.position, right.position)
    );
}

export function compileDamageTargeting(
    definition: DamageTargetingDefinition,
    purposes: readonly QueryPurpose[],
): CompiledTargeting<CombatTargetQueryContext> {
    const requiresHealingEligibility = purposes.includes("HEAL");

    return {
        candidates: function* ({ source, battlefield }) {
            if (definition.scope.type === "BLOCKER") {
                const blockerId = battlefield.blockerOf(source.id);

                if (blockerId !== undefined) {
                    yield blockerId;
                }
            } else {
                yield* battlefield.unitIds;
            }
        },

        accepts: (context, target) => {
            if (
                !isActiveVitalUnit(target) ||
                !hasSpatial(target) ||
                (target.spatial.layer === "AIR" && !definition.canTargetAir) ||
                !areHostile(context.source, target) ||
                (requiresHealingEligibility && hasStatusFlag(target, "HEAL_FREE"))
            ) {
                return false;
            }
            if (definition.scope.type === "BLOCKER") {
                return context.battlefield.blockerOf(context.source.id) === target.id;
            }
            if (definition.includeBlockingRelations && blockingRelated(context, target.id)) {
                return true;
            }

            return (
                acceptsHostileStatus(target, definition) &&
                hasHit(target) &&
                rangeOverlapsHit(
                    definition.scope.geometry,
                    context.source.position,
                    target.position,
                    target.hit.geometry,
                )
            );
        },

        compare: (context, left, right) => {
            if (definition.preferBlockingRelations) {
                const order =
                    Number(blockingRelated(context, right.id)) -
                    Number(blockingRelated(context, left.id));

                if (order !== 0) {
                    return order;
                }
            }

            return compareDistance(context, left, right);
        },

        limit: () => definition.maxTargets,
    };
}

export function compileHealingTargeting(
    definition: HealingTargetingDefinition,
    purposes: readonly QueryPurpose[],
    maxHp: HealingMaxHpProvider = staticMaxHp,
): CompiledTargeting<CombatTargetQueryContext> {
    const requiresHealingEligibility = purposes.includes("HEAL");

    return {
        candidates: ({ battlefield }) => battlefield.unitIds,

        accepts: (context, target) =>
            isActiveVitalUnit(target) &&
            hasSpatial(target) &&
            hasHit(target) &&
            (definition.includeSelf || target.id !== context.source.id) &&
            sameSide(context.source, target) &&
            target.vitality.hp < maxHp(target, context) &&
            (definition.ignoreAllyTargetFree || !hasStatusFlag(target, "ALLY_TARGET_FREE")) &&
            (!requiresHealingEligibility ||
                definition.ignoreHealFree ||
                !hasStatusFlag(target, "HEAL_FREE")) &&
            rangeOverlapsHit(
                definition.geometry,
                context.source.position,
                target.position,
                target.hit.geometry,
            ),

        compare: (context, left, right) => {
            if (!hasVitality(left) || !hasVitality(right)) {
                return 0;
            }

            return (
                left.vitality.hp / maxHp(left, context) - right.vitality.hp / maxHp(right, context)
            );
        },

        limit: () => definition.maxTargets,
    };
}

export function compileTargeting(
    definition: TargetingDefinition,
    purposes: readonly QueryPurpose[],
    maxHp?: HealingMaxHpProvider,
): CompiledTargeting<CombatTargetQueryContext> {
    switch (definition.type) {
        case "DAMAGE":
            return compileDamageTargeting(definition, purposes);

        case "HEAL":
            return compileHealingTargeting(definition, purposes, maxHp);
    }
}
