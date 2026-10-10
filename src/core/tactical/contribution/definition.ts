import * as contribution from "./state.js";
import type * as modifier from "./value.js";
import type * as computation from "./computation.js";
import type { BattlefieldView } from "../battlefield/contract.js";
import type { StableUnit, Unit } from "../unit/unit.js";
import { hasEffects } from "../unit/capability/effects/capability.js";
import type { Binding } from "../unit/capability/effects/binding.js";
import type { Effect, EffectValue } from "../unit/capability/effects/effect.js";
import type { EffectDefinition } from "../unit/capability/effects/definition.js";
import type { EffectResources } from "../unit/capability/effects/registry.js";

export type Target<M extends contribution.Mode = contribution.Mode> = <U extends Unit>(
    unit: U | StableUnit<U>,
    transition: contribution.Transition<M>,
) => StableUnit<U>;

export type SampledTarget = <U extends Unit>(
    unit: U | StableUnit<U>,
    transition: contribution.SampledTransition,
) => StableUnit<U>;

export interface QueryContext {
    readonly unit: Unit;
    readonly battlefield: BattlefieldView;
}

export interface Context<S extends object> extends QueryContext {
    readonly instance: Effect<S>;
}

export interface Options<S extends object = object> {
    readonly id?: string;
    readonly group?: contribution.Group | ((instance: Effect<S>) => contribution.Group | undefined);
}

interface Declaration<S extends object> {
    readonly id: string;
    readonly group?: Options<S>["group"];
}

export interface Sampled<S extends object> extends Declaration<S> {
    readonly kind: "SAMPLED";
    readonly target: SampledTarget;
    readonly sample: (instance: Effect<S>) => readonly modifier.Value[];
    readonly reconcile?: Binding["reconcile"];
}

export interface Live<S extends object> extends Declaration<S> {
    readonly kind: "LIVE";
    readonly target: Target;
    readonly evaluate: (context: Context<S>) => readonly modifier.Value[];
}

export type Definition<S extends object> = Sampled<S> | Live<S>;

export interface Resources {
    readonly effects: EffectResources;
    readonly computations: computation.Resources<QueryContext>;
}

export function compile<S extends object>(
    definition: EffectDefinition<S>,
    declarations: readonly Definition<NoInfer<S>>[],
    resources: Resources,
): readonly Binding[] {
    const ids = new Set<string>();

    for (const { id } of declarations) {
        if (id.length === 0) {
            throw new TypeError("effect contribution identity must be nonempty");
        }
        if (ids.has(id)) {
            throw new TypeError(`duplicate effect contribution ${definition.ref.id}/${id}`);
        }

        ids.add(id);
    }

    return declarations.map((declaration) => {
        const { id, target } = declaration;
        const declaredGroup = declaration.group;

        const group =
            typeof declaredGroup !== "function"
                ? declaredGroup
                : (instance: EffectValue) => {
                      const typed = resources.effects.typedEffect(instance, definition.ref);

                      if (typed === undefined) {
                          throw new TypeError(
                              "contribution group requires its matching effect definition",
                          );
                      }

                      return declaredGroup(typed);
                  };

        if (declaration.kind === "SAMPLED") {
            const { sample } = declaration;

            return sampledBinding({
                id: `projection/${id}`,
                target,
                group,
                ...(declaration.reconcile === undefined
                    ? {}
                    : { reconcile: declaration.reconcile }),
                sample: (instance) => {
                    const typed = resources.effects.typedEffect(instance, definition.ref);

                    if (typed === undefined) {
                        throw new TypeError(
                            "contribution projection requires its matching effect definition",
                        );
                    }

                    return sample(typed);
                },
            });
        }

        const { evaluate } = declaration;

        return liveBinding({
            id: `parameter/${id}`,
            target: declaration.target,
            computations: resources.computations,
            evaluator: JSON.stringify([definition.ref.id, id]),
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
                        : resources.effects.typedEffect(value, definition.ref);

                return instance === undefined ? [] : evaluate({ unit, battlefield, instance });
            },
        });
    });
}

interface Fields<T extends SampledTarget = SampledTarget> {
    readonly id: string;
    readonly target: T;
    readonly group:
        | contribution.Group
        | ((instance: EffectValue) => contribution.Group | undefined)
        | undefined;
    readonly reconcile?: Binding["reconcile"];
}

function groupOf(binding: Fields, instance: EffectValue): contribution.Group | undefined {
    return typeof binding.group === "function" ? binding.group(instance) : binding.group;
}

function contributionBinding(unit: Unit, instance: EffectValue, binding: Fields) {
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

function liveBinding(
    binding: Fields<Target> & {
        readonly computations: computation.Resources<QueryContext>;
        readonly evaluator: string;
        readonly evaluate: computation.Compute<QueryContext>;
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

function sampledBinding(
    binding: Fields & {
        readonly sample: (instance: EffectValue) => readonly modifier.Value[];
    },
): Binding {
    const { sample } = binding;
    const projected = (unit: Unit, instance: EffectValue): contribution.Sampled => ({
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
