import type { EffectInstance, EffectInstanceValue } from "../effect/instance.js";
import {
    registerNumericContribution,
    removeNumericContributionsOwnedBy,
    updateNumericContribution,
    type NumericContributionEvaluator,
    type NumericContributionGroup,
    type NumericContributionTransition,
    type NumericProviderContribution,
    type NumericValueContribution,
} from "../modifier/contribution.js";
import type { NumericContribution } from "../modifier/numeric.js";
import { hasOffense, updateOffenseContributions } from "../unit/capability/offense.js";
import { hasDefense, updateDefenseContributions } from "../unit/capability/defense.js";
import { hasVitality, updateVitalityMaxHpContributions } from "../unit/capability/vitality.js";
import type { Unit } from "../unit/unit.js";
import type { CombatWork } from "./work.js";

export type NumericContributionTarget = <U extends Unit>(
    unit: U,
    transition: NumericContributionTransition,
) => U;

export function offenseAttackContributions<U extends Unit>(
    unit: U,
    transition: NumericContributionTransition,
): U {
    if (!hasOffense(unit)) {
        throw new TypeError("attack contributions require Offense capability");
    }

    const offense = updateOffenseContributions(unit.offense, transition);

    return offense === unit.offense ? unit : { ...unit, offense };
}

export function defenseContributions<U extends Unit>(
    unit: U,
    transition: NumericContributionTransition,
): U {
    if (!hasDefense(unit)) {
        throw new TypeError("defense contributions require Defense capability");
    }

    const defense = updateDefenseContributions(unit.defense, "defense", transition);

    return defense === unit.defense ? unit : { ...unit, defense };
}

export function resistanceContributions<U extends Unit>(
    unit: U,
    transition: NumericContributionTransition,
): U {
    if (!hasDefense(unit)) {
        throw new TypeError("resistance contributions require Defense capability");
    }

    const defense = updateDefenseContributions(unit.defense, "resistance", transition);

    return defense === unit.defense ? unit : { ...unit, defense };
}

export function vitalityMaxHpContributions<U extends Unit>(
    unit: U,
    transition: NumericContributionTransition,
): U {
    if (!hasVitality(unit)) {
        throw new TypeError("maximum HP contributions require Vitality capability");
    }

    const vitality = updateVitalityMaxHpContributions(unit.vitality, transition);

    return vitality === unit.vitality ? unit : { ...unit, vitality };
}

export interface NumericProviderContext {
    readonly unit: Unit;
    readonly work: CombatWork;
    readonly entry: NumericProviderContribution;
}

export type CompiledNumericProvider = (
    context: NumericProviderContext,
) => readonly NumericContribution[];

export class NumericContributionResources {
    readonly #providers = new Map<string, CompiledNumericProvider>();

    register(ref: string, provider: CompiledNumericProvider): void {
        if (this.#providers.has(ref)) {
            throw new TypeError(`duplicate numeric provider ${ref}`);
        }

        this.#providers.set(ref, provider);
    }

    evaluator(unit: Unit, work: CombatWork): NumericContributionEvaluator {
        return (entry) => {
            const provider = this.#providers.get(entry.providerRef);

            if (provider === undefined) {
                throw new TypeError(`unregistered numeric provider ${entry.providerRef}`);
            }

            return provider({ unit, work, entry });
        };
    }
}

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
        readonly providers: NumericContributionResources;
        readonly providerRef: string;
        readonly evaluate: CompiledNumericProvider;
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
