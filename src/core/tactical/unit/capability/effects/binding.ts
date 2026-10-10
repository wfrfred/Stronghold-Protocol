import type { EffectInstanceValue } from "./instance.js";
import * as contribution from "../../../modifier/contribution.js";
import type * as modifier from "../../../modifier/value.js";
import type * as computation from "../../../modifier/computation.js";
import type { Target, SampledTarget, Context } from "../contribution.js";
import type { StableUnit, Unit } from "../../unit.js";

export interface Binding {
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
    readonly reconcile?: <U extends Unit>(
        previous: U | StableUnit<U>,
        current: U | StableUnit<U>,
    ) => StableUnit<U>;
}

interface Fields<T extends SampledTarget = SampledTarget> {
    readonly id: string;
    readonly target: T;
    readonly group:
        | contribution.Group
        | ((instance: EffectInstanceValue) => contribution.Group | undefined)
        | undefined;
    readonly reconcile?: Binding["reconcile"];
}

function groupOf(binding: Fields, instance: EffectInstanceValue): contribution.Group | undefined {
    return typeof binding.group === "function" ? binding.group(instance) : binding.group;
}

function contributionBinding(unit: Unit, instance: EffectInstanceValue, binding: Fields) {
    const group = groupOf(binding, instance);

    return {
        id: `@effect/${instance.id}/${binding.id}`,
        sequence: instance.acquiredSequence,
        participating: instance.participating,
        owner: { unitId: unit.id, instanceId: instance.id },
        ...(group === undefined ? {} : { group }),
    };
}

function participationBinding(binding: Fields): Binding["setParticipation"] {
    return (unit, instance, participating) =>
        binding.target(unit, (state) =>
            contribution.setParticipation(
                state,
                `@effect/${instance.id}/${binding.id}`,
                participating,
            ),
        );
}

function removeBinding(binding: Fields): Binding["remove"] {
    return (unit, instance) =>
        binding.target(unit, (state) =>
            contribution.removeOwnedBy(state, {
                unitId: unit.id,
                instanceId: instance.id,
            }),
        );
}

export function live(
    binding: Fields<Target> & {
        readonly computations: Pick<computation.Resources<Context>, "register">;
        readonly evaluator: string;
        readonly evaluate: computation.Compute<Context>;
    },
): Binding {
    const { evaluator, computations, evaluate } = binding;
    computations.register(evaluator, evaluate);

    return {
        install: (unit, instance) =>
            binding.target(unit, (state) =>
                contribution.register(state, {
                    kind: "LIVE",
                    ...contributionBinding(unit, instance, binding),
                    evaluator,
                }),
            ),
        update: (unit, instance) => {
            const group = groupOf(binding, instance);

            return binding.target(unit, (state) =>
                contribution.update(state, `@effect/${instance.id}/${binding.id}`, (entry) => {
                    const { group: previousGroup, ...unchanged } = entry;

                    return previousGroup === group
                        ? entry
                        : { ...unchanged, ...(group === undefined ? {} : { group }) };
                }),
            );
        },
        setParticipation: participationBinding(binding),
        remove: removeBinding(binding),
        ...(binding.reconcile === undefined ? {} : { reconcile: binding.reconcile }),
    };
}

export function sampled(
    binding: Fields & {
        readonly sample: (instance: EffectInstanceValue) => readonly modifier.Value[];
    },
): Binding {
    const { sample } = binding;
    const projected = (unit: Unit, instance: EffectInstanceValue): contribution.Sampled => ({
        kind: "SAMPLED",
        ...contributionBinding(unit, instance, binding),
        values: sample(instance),
    });

    return {
        install: (unit, instance) =>
            binding.target(unit, (state) =>
                contribution.register(state, projected(unit, instance)),
            ),
        update: (unit, instance) => {
            const updated = projected(unit, instance);

            return binding.target(unit, (state) =>
                contribution.update(state, updated.id, (entry) => ({
                    ...updated,
                    participating: entry.participating,
                })),
            );
        },
        setParticipation: participationBinding(binding),
        remove: removeBinding(binding),
        ...(binding.reconcile === undefined ? {} : { reconcile: binding.reconcile }),
    };
}
