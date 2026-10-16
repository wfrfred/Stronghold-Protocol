import { World } from "../../geometry/coordinate.js";
import { rangeOverlapsHit } from "../../geometry/intersection.js";
import type {
    CompiledTargeting,
    CombatTargetQueryContext,
    HealingMaxHpProvider,
    QueryPurpose,
} from "./query.js";
import { areHostile, hasAllegiance } from "../capability/allegiance/capability.js";
import { isSpatiallyPresent } from "../capability/presence/capability.js";
import { hasHit, hasSpatial } from "../capability/spatial/capability.js";
import { allowsTarget } from "../capability/targetable/capability.js";
import { damageRatio } from "../capability/elemental/query.js";
import { hasElemental } from "../capability/elemental/capability.js";
import { hasVitality, type Vitality } from "../capability/vitality/capability.js";
import { canReceiveHealing } from "../capability/vitality/healing/reception.js";
import type { Unit, Id } from "../unit.js";
import type {
    DamageTargetingDefinition,
    HealingTargetingDefinition,
    TargetingDefinition,
} from "./definition.js";

export interface ElementalQueries {
    readonly allowsDamage: (target: Unit, context: CombatTargetQueryContext) => boolean;
    readonly allowsHeal: (target: Unit, context: CombatTargetQueryContext) => boolean;
    readonly damageRatio: (target: Unit, context: CombatTargetQueryContext) => number;
}

function receivesElement(target: Unit): boolean {
    return (
        hasElemental(target) &&
        target.lifecycle === "PRESENT" &&
        isSpatiallyPresent(target) &&
        (!hasVitality(target) || target.vitality.hp > 0) &&
        target.elemental.burst === null
    );
}

const localElements: ElementalQueries = {
    allowsDamage: (target) =>
        receivesElement(target) && (!hasAllegiance(target) || target.allegiance.side !== "NEUTRAL"),
    allowsHeal: receivesElement,
    damageRatio: (target) => damageRatio(target),
};

const staticMaxHp: HealingMaxHpProvider = (unit) => unit.definition.vitality.maxHp;

function isActiveVitalUnit(target: Unit): target is Unit & Vitality {
    return hasVitality(target) && target.vitality.hp > 0 && isSpatiallyPresent(target);
}

function sameSide(source: Unit, target: Unit): boolean {
    return (
        hasAllegiance(source) &&
        hasAllegiance(target) &&
        source.allegiance.side === target.allegiance.side
    );
}

function blockingRelated(context: CombatTargetQueryContext, targetId: Id): boolean {
    const { source, battlefield } = context;

    return (
        battlefield.blockerOf(source.id) === targetId ||
        battlefield.blockedBy(source.id).includes(targetId)
    );
}

function compareDistance(context: CombatTargetQueryContext, left: Unit, right: Unit): number {
    return (
        World.distanceSquared(context.source.position, left.position) -
        World.distanceSquared(context.source.position, right.position)
    );
}

function compileDamageTargeting(
    definition: DamageTargetingDefinition,
    purposes: readonly QueryPurpose[],
    elemental: ElementalQueries,
): CompiledTargeting<CombatTargetQueryContext> {
    const requiresHealingEligibility = purposes.includes("HEAL");
    const requiresElementDamage = purposes.includes("ELEMENT_DAMAGE");
    const requiresElementHealing = purposes.includes("ELEMENT_HEAL");
    const elementOnly =
        !purposes.includes("DAMAGE") &&
        !requiresHealingEligibility &&
        (requiresElementDamage || requiresElementHealing);

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
                !(elementOnly ? isSpatiallyPresent(target) : isActiveVitalUnit(target)) ||
                !hasSpatial(target) ||
                (target.spatial.layer === "AIR" && !definition.canTargetAir) ||
                !areHostile(context.source, target) ||
                (requiresHealingEligibility &&
                    !canReceiveHealing({
                        ...context,
                        target,
                        ignoreHealFree: false,
                    })) ||
                (requiresElementDamage && !elemental.allowsDamage(target, context)) ||
                (requiresElementHealing && !elemental.allowsHeal(target, context))
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
                allowsTarget({ ...context, target, selector: definition, purposes }) &&
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

function compileHealingTargeting(
    definition: HealingTargetingDefinition,
    purposes: readonly QueryPurpose[],
    maxHp: HealingMaxHpProvider = staticMaxHp,
    elemental: ElementalQueries = localElements,
): CompiledTargeting<CombatTargetQueryContext> {
    const requiresHealingEligibility = purposes.includes("HEAL");
    const elementHealing = purposes.includes("ELEMENT_HEAL");
    const elementOnly = elementHealing && !requiresHealingEligibility;

    return {
        candidates: ({ battlefield }) => battlefield.unitIds,

        accepts: (context, target) =>
            isSpatiallyPresent(target) &&
            hasSpatial(target) &&
            hasHit(target) &&
            (definition.includeSelf || target.id !== context.source.id) &&
            sameSide(context.source, target) &&
            (elementOnly
                ? elemental.damageRatio(target, context) > 0
                : isActiveVitalUnit(target) && target.vitality.hp < maxHp(target, context)) &&
            (!elementHealing || elemental.allowsHeal(target, context)) &&
            allowsTarget({ ...context, target, selector: definition, purposes }) &&
            (!requiresHealingEligibility ||
                canReceiveHealing({
                    ...context,
                    target,
                    ignoreHealFree: definition.ignoreHealFree,
                })) &&
            rangeOverlapsHit(
                definition.geometry,
                context.source.position,
                target.position,
                target.hit.geometry,
            ),

        compare: (context, left, right) => {
            if (elementOnly) {
                return elemental.damageRatio(right, context) - elemental.damageRatio(left, context);
            }
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
    elemental: ElementalQueries = localElements,
): CompiledTargeting<CombatTargetQueryContext> {
    switch (definition.type) {
        case "DAMAGE":
            return compileDamageTargeting(definition, purposes, elemental);

        case "HEAL":
            return compileHealingTargeting(definition, purposes, maxHp, elemental);
    }
}
