import type { EffectInstance, EffectInstanceValue } from "./instance.js";
import {
    registerNumericContribution,
    removeNumericContributionsOwnedBy,
    updateNumericContribution,
    setNumericContributionParticipation,
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
    readonly setParticipation: <U extends Unit>(
        unit: U,
        instance: EffectInstanceValue,
        participating: boolean,
    ) => U;
    readonly remove: <U extends Unit>(unit: U, instance: EffectInstanceValue) => U;
}

interface ContributionBinding {
    readonly id: string;
    readonly target: NumericContributionTarget;
    readonly group: NumericContributionGroup | undefined;
}

function ownBinding(binding: ContributionBinding): ContributionBinding {
    return Object.freeze({
        id: binding.id,
        target: binding.target,
        group: binding.group === undefined ? undefined : Object.freeze({ ...binding.group }),
    });
}

function contributionBinding(
    unit: Unit,
    instance: EffectInstanceValue,
    binding: ContributionBinding,
) {
    return {
        id: `@effect/${instance.id}/${binding.id}`,
        sequence: instance.acquiredSequence,
        participating: instance.participating,
        owner: { unitId: unit.id, instanceId: instance.id },
        ...(binding.group === undefined ? {} : { group: binding.group }),
    };
}

function participationBinding(
    binding: ContributionBinding,
): CompiledEffectContribution["setParticipation"] {
    return (unit, instance, participating) =>
        binding.target(unit, (state) =>
            setNumericContributionParticipation(
                state,
                `@effect/${instance.id}/${binding.id}`,
                participating,
            ),
        );
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
    const owned = ownBinding(binding);
    const { providerRef, providers, evaluate } = binding;
    providers.register(providerRef, evaluate);

    return {
        install: (unit, instance) =>
            owned.target(unit, (state) =>
                registerNumericContribution(state, {
                    ...contributionBinding(unit, instance, owned),
                    providerRef,
                }),
            ),
        update: (unit) => unit,
        setParticipation: participationBinding(owned),
        remove: removeBinding(owned),
    };
}

export function compileNumericProjectionBinding(
    binding: ContributionBinding & {
        readonly project: (instance: EffectInstanceValue) => readonly NumericContribution[];
    },
): CompiledEffectContribution {
    const owned = ownBinding(binding);
    const { project } = binding;
    const projected = (unit: Unit, instance: EffectInstanceValue): NumericValueContribution => ({
        ...contributionBinding(unit, instance, owned),
        values: project(instance),
    });

    return {
        install: (unit, instance) =>
            owned.target(unit, (state) =>
                registerNumericContribution(state, projected(unit, instance)),
            ),
        update: (unit, instance) => {
            const contribution = projected(unit, instance);

            return owned.target(unit, (state) =>
                updateNumericContribution(state, contribution.id, (entry) => ({
                    ...contribution,
                    participating: entry.participating,
                })),
            );
        },
        setParticipation: participationBinding(owned),
        remove: removeBinding(owned),
    };
}
