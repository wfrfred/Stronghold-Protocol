import type { EffectInstanceValue } from "./instance.js";
import * as contribution from "../../../modifier/contribution.js";
import type * as modifier from "../../../modifier/value.js";
import type * as computation from "../../../modifier/computation.js";
import type {
    ContributionTarget,
    StoredContributionTarget,
    ContributionFacts,
} from "../contribution.js";
import { stabilizeUnit, type StableUnit, type Unit } from "../../unit.js";

export interface EffectBinding {
    readonly install: <U extends Unit>(
        unit: U | StableUnit<U>,
        instance: EffectInstanceValue,
    ) => StableUnit<U>;
    readonly update: <U extends Unit>(
        unit: U | StableUnit<U>,
        instance: EffectInstanceValue,
    ) => StableUnit<U>;
    readonly setParticipation: <U extends Unit>(
        unit: U | StableUnit<U>,
        instance: EffectInstanceValue,
        participating: boolean,
    ) => StableUnit<U>;
    readonly remove: <U extends Unit>(
        unit: U | StableUnit<U>,
        instance: EffectInstanceValue,
    ) => StableUnit<U>;
}

interface ContributionBinding<T extends StoredContributionTarget = StoredContributionTarget> {
    readonly id: string;
    readonly target: T;
    readonly group: contribution.Group | undefined;
}

function ownBinding<T extends StoredContributionTarget>(
    binding: ContributionBinding<T>,
): ContributionBinding<T> {
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

function participationBinding(binding: ContributionBinding): EffectBinding["setParticipation"] {
    return (unit, instance, participating) =>
        binding.target(unit, (state) =>
            contribution.setParticipation(
                state,
                `@effect/${instance.id}/${binding.id}`,
                participating,
            ),
        );
}

function removeBinding(binding: ContributionBinding): EffectBinding["remove"] {
    return (unit, instance) =>
        binding.target(unit, (state) =>
            contribution.removeOwnedBy(state, {
                unitId: unit.id,
                instanceId: instance.id,
            }),
        );
}

export function compileComputedBinding(
    binding: ContributionBinding<ContributionTarget> & {
        readonly computations: Pick<computation.Resources<ContributionFacts>, "register">;
        readonly computeRef: string;
        readonly compute: computation.Compute<ContributionFacts>;
    },
): EffectBinding {
    const owned = ownBinding(binding);
    const { computeRef, computations, compute } = binding;
    computations.register(computeRef, compute);

    return {
        install: (unit, instance) =>
            owned.target(unit, (state) =>
                contribution.register(state, {
                    ...contributionBinding(unit, instance, owned),
                    computeRef,
                }),
            ),
        update: stabilizeUnit,
        setParticipation: participationBinding(owned),
        remove: removeBinding(owned),
    };
}

export function compileStoredBinding(
    binding: ContributionBinding & {
        readonly sample: (instance: EffectInstanceValue) => readonly modifier.Value[];
    },
): EffectBinding {
    const owned = ownBinding(binding);
    const { sample } = binding;
    const projected = (unit: Unit, instance: EffectInstanceValue): contribution.Stored => ({
        ...contributionBinding(unit, instance, owned),
        values: sample(instance),
    });

    return {
        install: (unit, instance) =>
            owned.target(unit, (state) => contribution.register(state, projected(unit, instance))),
        update: (unit, instance) => {
            const updated = projected(unit, instance);

            return owned.target(unit, (state) =>
                contribution.update(state, updated.id, (entry) => ({
                    ...updated,
                    participating: entry.participating,
                })),
            );
        },
        setParticipation: participationBinding(owned),
        remove: removeBinding(owned),
    };
}
