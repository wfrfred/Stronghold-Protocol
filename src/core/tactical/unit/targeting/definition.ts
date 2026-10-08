import { assertPositiveSafeInteger } from "../../../common/assert.js";
import { createRangeGeometry, type RangeGeometry } from "../../geometry/shape.js";

export type DamageTargetScope =
    { readonly type: "RANGE"; readonly geometry: RangeGeometry } | { readonly type: "BLOCKER" };

export interface DamageTargetingDefinition {
    readonly type: "DAMAGE";
    readonly scope: DamageTargetScope;
    readonly canTargetAir: boolean;
    readonly includeBlockingRelations: boolean;
    readonly preferBlockingRelations: boolean;
    readonly ignoreTargetFree: boolean;
    readonly ignoreInvisible: boolean;
    readonly maxTargets: number;
}

export interface HealingTargetingDefinition {
    readonly type: "HEAL";
    readonly geometry: RangeGeometry;
    readonly includeSelf: boolean;
    readonly ignoreAllyTargetFree: boolean;
    readonly ignoreHealFree: boolean;
    readonly maxTargets: number;
}

export type TargetingDefinition = DamageTargetingDefinition | HealingTargetingDefinition;

export function createTargetingDefinition(definition: TargetingDefinition): TargetingDefinition {
    assertPositiveSafeInteger(definition.maxTargets, "maxTargets");

    switch (definition.type) {
        case "DAMAGE": {
            const scope = definition.scope;

            return Object.freeze({
                ...definition,
                scope:
                    scope.type === "RANGE"
                        ? Object.freeze({
                              type: scope.type,
                              geometry: createRangeGeometry(scope.geometry),
                          })
                        : Object.freeze({ type: scope.type }),
            });
        }

        case "HEAL":
            return Object.freeze({
                ...definition,
                geometry: createRangeGeometry(definition.geometry),
            });
    }
}
