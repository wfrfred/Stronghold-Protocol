import type { NumericContributionGroup } from "../../../modifier/contribution.js";
import type { NumericContribution } from "../../../modifier/numeric.js";
import type { NumericContributionResources } from "../../../modifier/providers.js";
import type { Unit } from "../../unit.js";
import type { CombatTargetingView } from "../../targeting/query.js";
import type {
    NumericContributionTarget,
    NumericProjectionTarget,
    NumericProviderFacts,
} from "../contribution.js";
import { hasEffects } from "./capability.js";
import {
    compileNumericProviderBinding,
    compileNumericProjectionBinding,
    type CompiledEffectContribution,
} from "./contribution-bindings.js";
import type { EffectInstance } from "./instance.js";
import type { EffectProgram } from "./program.js";
import type { EffectResources } from "./registry.js";

export interface EffectContributionContext<S extends object> {
    readonly unit: Unit;
    readonly battlefield: CombatTargetingView;
    readonly instance: EffectInstance<S>;
}

export interface EffectContributionOptions {
    readonly id?: string;
    readonly group?: NumericContributionGroup;
}

interface ContributionDeclaration {
    readonly id: string;
    readonly group?: NumericContributionGroup;
}

export interface SampledEffectContribution<S extends object> extends ContributionDeclaration {
    readonly target: NumericProjectionTarget;
    readonly sample: (instance: EffectInstance<S>) => readonly NumericContribution[];
}

export interface ComputedEffectContribution<S extends object> extends ContributionDeclaration {
    readonly target: NumericContributionTarget;
    readonly providers: (
        resources: EffectContributionResources,
    ) => NumericContributionResources<NumericProviderFacts>;
    readonly compute: (context: EffectContributionContext<S>) => readonly NumericContribution[];
}

export type EffectContribution<S extends object> =
    SampledEffectContribution<S> | ComputedEffectContribution<S>;

export interface EffectContributionResources {
    readonly effects: EffectResources;
    readonly offense: NumericContributionResources<NumericProviderFacts>;
    readonly defense: NumericContributionResources<NumericProviderFacts>;
}

export function compileEffectContributions<S extends object>(
    program: EffectProgram<S>,
    declarations: readonly EffectContribution<NoInfer<S>>[],
    resources: EffectContributionResources,
): readonly CompiledEffectContribution[] {
    const ids = new Set<string>();

    for (const { id } of declarations) {
        if (id.length === 0) {
            throw new TypeError("effect contribution identity must be nonempty");
        }
        if (ids.has(id)) {
            throw new TypeError(`duplicate effect contribution ${program.ref.id}/${id}`);
        }

        ids.add(id);
    }

    return declarations.map((declaration) => {
        const { id, target } = declaration;
        const group =
            declaration.group === undefined ? undefined : Object.freeze({ ...declaration.group });

        if ("sample" in declaration) {
            const { sample } = declaration;

            return compileNumericProjectionBinding({
                id: `projection/${id}`,
                target,
                group,
                project: (instance) => {
                    const typed = resources.effects.typedInstance(instance, program.ref);

                    if (typed === undefined) {
                        throw new TypeError(
                            "contribution projection requires its matching effect program",
                        );
                    }

                    return sample(typed);
                },
            });
        }

        const { compute } = declaration;

        return compileNumericProviderBinding({
            id: `parameter/${id}`,
            target: declaration.target,
            providers: declaration.providers(resources),
            providerRef: `${program.ref.id}/${id}`,
            group,
            evaluate: ({ unit, battlefield }, entry) => {
                const owner = entry.owner;
                const receiver =
                    owner === undefined ? undefined : battlefield.getUnit(owner.unitId);
                const value =
                    receiver !== undefined && hasEffects(receiver)
                        ? receiver.effects.instances.find(
                              (instance) => instance.id === owner?.instanceId,
                          )
                        : undefined;
                const instance =
                    value === undefined
                        ? undefined
                        : resources.effects.typedInstance(value, program.ref);

                return instance === undefined ? [] : compute({ unit, battlefield, instance });
            },
        });
    });
}
