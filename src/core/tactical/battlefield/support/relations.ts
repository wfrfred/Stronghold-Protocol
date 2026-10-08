import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import { readSupportFacts } from "./facts.js";

export interface SupportRelation {
    readonly supportedUnitId: UnitId;
    readonly supportUnitId: UnitId;
}

function isValidSupportRelation(
    units: ReadonlyMap<UnitId, Unit>,
    relation: SupportRelation,
): boolean {
    const provider = units.get(relation.supportUnitId);
    const supported = units.get(relation.supportedUnitId);

    if (provider === undefined || supported === undefined || provider.id === supported.id) {
        return false;
    }

    const providerFacts = readSupportFacts(provider);
    const supportedFacts = readSupportFacts(supported);

    return (
        providerFacts.present &&
        supportedFacts.present &&
        providerFacts.provider &&
        providerFacts.claims.some(
            (providerClaim) =>
                providerClaim.slot === "SUPPORT" &&
                supportedFacts.claims.some(
                    (supportedClaim) =>
                        supportedClaim.slot === "DEPLOYMENT" &&
                        providerClaim.position[0] === supportedClaim.position[0] &&
                        providerClaim.position[1] === supportedClaim.position[1],
                ),
        )
    );
}

export function reconcileSupportRelations(
    units: ReadonlyMap<UnitId, Unit>,
    relations: readonly SupportRelation[],
): readonly SupportRelation[] {
    const retained = relations.filter((relation) => isValidSupportRelation(units, relation));

    return retained.length === relations.length ? relations : retained;
}

export function getLostSupports(
    previous: readonly SupportRelation[],
    next: readonly SupportRelation[],
    units: ReadonlyMap<UnitId, Unit>,
): readonly SupportRelation[] {
    const supportedIds = new Set(next.map((relation) => relation.supportedUnitId));

    return previous.filter((relation) => {
        const supported = units.get(relation.supportedUnitId);

        return (
            !supportedIds.has(relation.supportedUnitId) &&
            supported !== undefined &&
            isSpatiallyPresent(supported)
        );
    });
}

export function validateSupportRelations(
    units: ReadonlyMap<UnitId, Unit>,
    relations: readonly SupportRelation[],
): void {
    const supportedIds = new Set<UnitId>();

    for (const relation of relations) {
        if (supportedIds.has(relation.supportedUnitId)) {
            throw new RangeError(`duplicate support relation for unit ${relation.supportedUnitId}`);
        }
        if (!isValidSupportRelation(units, relation)) {
            throw new RangeError(`invalid support relation for unit ${relation.supportedUnitId}`);
        }

        supportedIds.add(relation.supportedUnitId);
    }
}
