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

interface Compiled<T extends SampledTarget = SampledTarget> {
    readonly id: string;
    readonly target: T;
    readonly group: (instance: EffectInstanceValue) => contribution.Group | undefined;
    readonly reconcile?: Binding["reconcile"];
}

function ownBinding<T extends SampledTarget>(binding: Fields<T>): Compiled<T> {
    const declaredGroup = binding.group;
    const fixedGroup =
        declaredGroup === undefined || typeof declaredGroup === "function"
            ? undefined
            : Object.freeze({ id: declaredGroup.id, strength: declaredGroup.strength });

    return Object.freeze({
        id: binding.id,
        target: binding.target,
        group: typeof declaredGroup === "function" ? declaredGroup : () => fixedGroup,
        ...(binding.reconcile === undefined ? {} : { reconcile: binding.reconcile }),
    });
}

function contributionBinding(unit: Unit, instance: EffectInstanceValue, binding: Compiled) {
    const group = binding.group(instance);

    return {
        id: `@effect/${instance.id}/${binding.id}`,
        sequence: instance.acquiredSequence,
        participating: instance.participating,
        owner: { unitId: unit.id, instanceId: instance.id },
        ...(group === undefined ? {} : { group }),
    };
}

function participationBinding(binding: Compiled): Binding["setParticipation"] {
    return (unit, instance, participating) =>
        binding.target(unit, (state) =>
            contribution.setParticipation(
                state,
                `@effect/${instance.id}/${binding.id}`,
                participating,
            ),
        );
}

function removeBinding(binding: Compiled): Binding["remove"] {
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
    const owned = ownBinding(binding);
    const { evaluator, computations, evaluate } = binding;
    computations.register(evaluator, evaluate);

    return {
        install: (unit, instance) =>
            owned.target(unit, (state) =>
                contribution.register(state, {
                    kind: "LIVE",
                    ...contributionBinding(unit, instance, owned),
                    evaluator,
                }),
            ),
        update: (unit, instance) => {
            const group = owned.group(instance);

            return owned.target(unit, (state) =>
                contribution.update(state, `@effect/${instance.id}/${owned.id}`, (entry) => {
                    const { group: previousGroup, ...unchanged } = entry;

                    return previousGroup === group
                        ? entry
                        : { ...unchanged, ...(group === undefined ? {} : { group }) };
                }),
            );
        },
        setParticipation: participationBinding(owned),
        remove: removeBinding(owned),
        ...(owned.reconcile === undefined ? {} : { reconcile: owned.reconcile }),
    };
}

export function sampled(
    binding: Fields & {
        readonly sample: (instance: EffectInstanceValue) => readonly modifier.Value[];
    },
): Binding {
    const owned = ownBinding(binding);
    const { sample } = binding;
    const projected = (unit: Unit, instance: EffectInstanceValue): contribution.Sampled => ({
        kind: "SAMPLED",
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
        ...(owned.reconcile === undefined ? {} : { reconcile: owned.reconcile }),
    };
}
