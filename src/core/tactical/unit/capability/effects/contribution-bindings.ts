import type { EffectInstance, EffectInstanceValue } from "./instance.js";
import {
    registerNumericContribution,
    removeNumericContributionsOwnedBy,
    updateNumericContribution,
    type NumericContributionGroup,
    type NumericValueContribution,
} from "../../../modifier/contribution.js";
import type { NumericContribution } from "../../../modifier/numeric.js";
import type {
    CompiledNumericProvider,
    NumericContributionResources,
} from "../../../modifier/providers.js";
import type { NumericContributionTarget, NumericProviderFacts } from "../contribution.js";
import type { Unit } from "../../unit.js";

export interface EffectContributionProjection<S extends object> {
    readonly id: string;
    readonly target: NumericContributionTarget;
    readonly project: (instance: EffectInstance<S>) => readonly NumericContribution[];
    readonly group?: NumericContributionGroup;
}

export interface CompiledEffectContribution {
    readonly install: <U extends Unit>(unit: U, instance: EffectInstanceValue) => U;
    readonly update: <U extends Unit>(unit: U, instance: EffectInstanceValue) => U;
    readonly remove: <U extends Unit>(unit: U, instance: EffectInstanceValue) => U;
}

interface ContributionBinding {
    readonly id: string;
    readonly target: NumericContributionTarget;
    readonly group: NumericContributionGroup | undefined;
}

function contributionBinding(
    unit: Unit,
    instance: EffectInstanceValue,
    binding: ContributionBinding,
) {
    return {
        id: `@effect/${instance.id}/${binding.id}`,
        sequence: instance.acquiredSequence,
        participating: true,
        owner: { unitId: unit.id, instanceId: instance.id },
        ...(binding.group === undefined ? {} : { group: binding.group }),
    };
}

function removeBinding(binding: ContributionBinding): CompiledEffectContribution["remove"] {
    return (unit, instance) =>
        binding.target(unit, (state) =>
            removeNumericContributionsOwnedBy(state, {
                unitId: unit.id,
                instanceId: instance.id,
            }),
        );
}

export function compileNumericProviderBinding(
    binding: ContributionBinding & {
        readonly providers: NumericContributionResources<NumericProviderFacts>;
        readonly providerRef: string;
        readonly evaluate: CompiledNumericProvider<NumericProviderFacts>;
    },
): CompiledEffectContribution {
    binding.providers.register(binding.providerRef, binding.evaluate);

    return {
        install: (unit, instance) =>
            binding.target(unit, (state) =>
                registerNumericContribution(state, {
                    ...contributionBinding(unit, instance, binding),
                    providerRef: binding.providerRef,
                }),
            ),
        update: (unit) => unit,
        remove: removeBinding(binding),
    };
}

export function compileNumericProjectionBinding(
    binding: ContributionBinding & {
        readonly project: (instance: EffectInstanceValue) => readonly NumericContribution[];
    },
): CompiledEffectContribution {
    const projected = (unit: Unit, instance: EffectInstanceValue): NumericValueContribution => ({
        ...contributionBinding(unit, instance, binding),
        values: binding.project(instance),
    });

    return {
        install: (unit, instance) =>
            binding.target(unit, (state) =>
                registerNumericContribution(state, projected(unit, instance)),
            ),
        update: (unit, instance) => {
            const contribution = projected(unit, instance);

            return binding.target(unit, (state) =>
                updateNumericContribution(state, contribution.id, (entry) => ({
                    ...contribution,
                    participating: entry.participating,
                })),
            );
        },
        remove: removeBinding(binding),
    };
}
