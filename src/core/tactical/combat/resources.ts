import {
    EffectResources,
    type EffectInstance,
    type EffectInstanceValue,
    type EffectProgram,
    type EffectProgramRef,
} from "../effect/instance.js";
import type { NumericContribution } from "../modifier/numeric.js";
import { createEffectsState, hasEffects } from "../unit/capability/effects.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { DamageOperands, DamageReport, DamageRequest, PendingDamage } from "./contract.js";
import { combatWorkView, getCombatUnit, updateCombatUnit, type CombatWork } from "./work.js";
import type { CombatTargetingView } from "./targeting.js";

export interface ParameterContext<S extends object> {
    readonly unit: Unit;
    readonly battlefield: CombatTargetingView;
    readonly instance: EffectInstance<S>;
}

export type ParameterProvider<S extends object> = (
    context: ParameterContext<S>,
) => readonly NumericContribution[];

export interface DamageRuleContext<S extends object> {
    readonly work: CombatWork;
    readonly request: DamageRequest;
    readonly ownerUnitId: UnitId;
    readonly instance: EffectInstance<S>;
    readonly resources: CombatResources;
}

export type DamageRule<S extends object, V> = (
    context: DamageRuleContext<S>,
    value: V,
) => { readonly work: CombatWork; readonly value: V };

export type DamageReaction<S extends object> = (
    context: DamageRuleContext<S>,
    report: DamageReport,
) => CombatWork;

export interface OrderedRule<F> {
    readonly priority: number;
    readonly apply: F;
}

export interface CombatEffectRules<S extends object> {
    readonly group?: { readonly id: string; readonly strength: number };
    readonly attack?: ParameterProvider<S>;
    readonly defense?: ParameterProvider<S>;
    readonly resistance?: ParameterProvider<S>;
    readonly maxHp?: ParameterProvider<S>;
    readonly sourceFormula?: readonly OrderedRule<DamageRule<S, DamageOperands>>[];
    readonly targetFormula?: readonly OrderedRule<DamageRule<S, DamageOperands>>[];
    readonly output?: readonly OrderedRule<DamageRule<S, PendingDamage>>[];
    readonly reception?: readonly OrderedRule<DamageRule<S, PendingDamage>>[];
    readonly reaction?: readonly OrderedRule<DamageReaction<S>>[];
}

type ParameterKey = "attack" | "defense" | "resistance" | "maxHp";

type FormulaStage = "sourceFormula" | "targetFormula";

type AmountStage = "output" | "reception";

interface BoundRule<V> {
    readonly priority: number;
    readonly order: number;
    readonly apply: (
        work: CombatWork,
        request: DamageRequest,
        value: V,
    ) => {
        readonly work: CombatWork;
        readonly value: V;
    };
}

interface BoundReaction {
    readonly priority: number;
    readonly order: number;
    readonly apply: (work: CombatWork, report: DamageReport) => CombatWork;
}

interface ProgramRules {
    readonly group: CombatEffectRules<object>["group"];
    readonly hasParameter: (key: ParameterKey) => boolean;
    readonly hasRules: (stage: FormulaStage | AmountStage | "reaction") => boolean;
    readonly parameters: (
        key: ParameterKey,
        unit: Unit,
        work: CombatWork,
        instance: EffectInstanceValue,
    ) => readonly NumericContribution[];
    readonly formula: (
        stage: FormulaStage,
        ownerUnitId: UnitId,
        instanceId: number,
    ) => readonly BoundRule<DamageOperands>[];
    readonly amount: (
        stage: AmountStage,
        ownerUnitId: UnitId,
        instanceId: number,
    ) => readonly BoundRule<PendingDamage>[];
    readonly reactions: (ownerUnitId: UnitId, instanceId: number) => readonly BoundReaction[];
}

interface ActiveProgram {
    readonly instance: EffectInstanceValue;
    readonly rules: ProgramRules;
}

function orderInstances(left: ActiveProgram, right: ActiveProgram): number {
    return (
        left.instance.acquiredSequence - right.instance.acquiredSequence ||
        left.instance.id - right.instance.id
    );
}

function orderRules(
    left: {
        readonly priority: number;
        readonly sequence: number;
        readonly instanceId: number;
        readonly order: number;
    },
    right: typeof left,
): number {
    return (
        right.priority - left.priority ||
        left.sequence - right.sequence ||
        left.instanceId - right.instanceId ||
        left.order - right.order
    );
}

export class CombatResources {
    readonly effects = new EffectResources();
    readonly #rules = new Map<string, ProgramRules>();

    registerEffect<S extends object>(
        program: EffectProgram<S>,
        rules: NoInfer<CombatEffectRules<S>>,
    ): EffectProgram<S> {
        this.effects.register(program);

        const current = (
            work: CombatWork,
            ownerUnitId: UnitId,
            instanceId: number,
        ): EffectInstance<S> | undefined => {
            const owner = getCombatUnit(work, ownerUnitId);
            const instance =
                owner !== undefined && hasEffects(owner)
                    ? owner.effects.instances.find((value) => value.id === instanceId)
                    : undefined;

            if (instance === undefined) {
                return undefined;
            }

            return this.effects.typedInstance(instance, program.ref);
        };

        const bind = <V>(
            entries: readonly OrderedRule<DamageRule<S, V>>[] | undefined,
            ownerUnitId: UnitId,
            instanceId: number,
        ): readonly BoundRule<V>[] =>
            (entries ?? []).map(({ priority, apply }, order) => ({
                priority,
                order,
                apply: (work, request, value) => {
                    const instance = current(work, ownerUnitId, instanceId);

                    return instance === undefined
                        ? { work, value }
                        : apply({ work, request, ownerUnitId, instance, resources: this }, value);
                },
            }));

        const parameterProviders = {
            attack: rules.attack,
            defense: rules.defense,
            resistance: rules.resistance,
            maxHp: rules.maxHp,
        };
        const sourceFormula = rules.sourceFormula?.map((entry) => ({ ...entry }));
        const targetFormula = rules.targetFormula?.map((entry) => ({ ...entry }));
        const output = rules.output?.map((entry) => ({ ...entry }));
        const reception = rules.reception?.map((entry) => ({ ...entry }));
        const reaction = rules.reaction?.map((entry) => ({ ...entry }));
        const stageRules = { sourceFormula, targetFormula, output, reception, reaction };

        this.#rules.set(program.ref.id, {
            group: rules.group === undefined ? undefined : { ...rules.group },
            hasParameter: (key) => parameterProviders[key] !== undefined,
            hasRules: (stage) => (stageRules[stage]?.length ?? 0) > 0,
            parameters: (key, unit, work, instance) => {
                const provider = parameterProviders[key];
                const typed = this.effects.typedInstance(instance, program.ref);

                return provider === undefined || typed === undefined
                    ? []
                    : provider({
                          unit,
                          battlefield: combatWorkView(work),
                          instance: typed,
                      });
            },
            formula: (stage, ownerUnitId, instanceId) =>
                bind(
                    stage === "sourceFormula" ? sourceFormula : targetFormula,
                    ownerUnitId,
                    instanceId,
                ),
            amount: (stage, ownerUnitId, instanceId) =>
                bind(stage === "output" ? output : reception, ownerUnitId, instanceId),
            reactions: (ownerUnitId, instanceId) =>
                (reaction ?? []).map(({ priority, apply }, order) => ({
                    priority,
                    order,
                    apply: (work, report) => {
                        const instance = current(work, ownerUnitId, instanceId);

                        return instance === undefined
                            ? work
                            : apply(
                                  {
                                      work,
                                      request: report.request,
                                      ownerUnitId,
                                      instance,
                                      resources: this,
                                  },
                                  report,
                              );
                    },
                })),
        });

        return program;
    }

    updateEffectState<S extends object>(
        work: CombatWork,
        ownerUnitId: UnitId,
        instanceId: number,
        ref: EffectProgramRef<S>,
        state: NoInfer<S>,
    ): CombatWork {
        const owner = getCombatUnit(work, ownerUnitId);

        if (owner === undefined || !hasEffects(owner)) {
            return work;
        }

        const instance = owner.effects.instances.find((value) => value.id === instanceId);

        if (instance === undefined) {
            return work;
        }

        const updated = this.effects.update(instance, ref, state);

        if (updated === instance) {
            return work;
        }

        const unit = {
            ...owner,
            effects: createEffectsState(
                owner.effects.instances.map((value) => (value === instance ? updated : value)),
            ),
        };

        return updateCombatUnit(work, unit);
    }

    #active(
        unit: Unit | undefined,
        participates: (rules: ProgramRules) => boolean,
    ): readonly ActiveProgram[] {
        if (unit === undefined || !hasEffects(unit)) {
            return [];
        }

        const candidates = unit.effects.instances
            .map((instance): ActiveProgram => {
                const rules = this.#rules.get(instance.programRef.id);

                if (rules === undefined) {
                    throw new TypeError(`unregistered combat effect ${instance.programRef.id}`);
                }

                return { instance, rules };
            })
            .filter(({ rules }) => participates(rules))
            .sort(orderInstances);
        const winners = new Map<string, ActiveProgram>();

        for (const entry of candidates) {
            const group = entry.rules.group;

            if (group === undefined) {
                continue;
            }

            const winner = winners.get(group.id);

            if (winner === undefined || group.strength > winner.rules.group!.strength) {
                winners.set(group.id, entry);
            }
        }

        return candidates.filter(
            (entry) =>
                entry.rules.group === undefined || winners.get(entry.rules.group.id) === entry,
        );
    }

    contributions(key: ParameterKey, unit: Unit, work: CombatWork): readonly NumericContribution[] {
        return this.#active(unit, (rules) => rules.hasParameter(key)).flatMap(
            ({ rules, instance }) => rules.parameters(key, unit, work, instance),
        );
    }

    formulaRules(
        work: CombatWork,
        ownerUnitId: UnitId | null,
        stage: FormulaStage,
    ): readonly BoundRule<DamageOperands>[] {
        return ownerUnitId === null
            ? []
            : this.#active(getCombatUnit(work, ownerUnitId), (rules) => rules.hasRules(stage))
                  .flatMap(({ rules, instance }) =>
                      rules.formula(stage, ownerUnitId, instance.id).map((rule) => ({
                          ...rule,
                          sequence: instance.acquiredSequence,
                          instanceId: instance.id,
                      })),
                  )
                  .sort(orderRules);
    }

    amountRules(
        work: CombatWork,
        ownerUnitId: UnitId | null,
        stage: AmountStage,
    ): readonly BoundRule<PendingDamage>[] {
        return ownerUnitId === null
            ? []
            : this.#active(getCombatUnit(work, ownerUnitId), (rules) => rules.hasRules(stage))
                  .flatMap(({ rules, instance }) =>
                      rules.amount(stage, ownerUnitId, instance.id).map((rule) => ({
                          ...rule,
                          sequence: instance.acquiredSequence,
                          instanceId: instance.id,
                      })),
                  )
                  .sort(orderRules);
    }

    reactionRules(
        work: CombatWork,
        ownerUnitIds: readonly (UnitId | null)[],
    ): readonly BoundReaction[] {
        const ids = [...new Set(ownerUnitIds.filter((id): id is UnitId => id !== null))];

        return ids
            .flatMap((id) =>
                this.#active(getCombatUnit(work, id), (rules) =>
                    rules.hasRules("reaction"),
                ).flatMap(({ rules, instance }) =>
                    rules.reactions(id, instance.id).map((rule) => ({
                        ...rule,
                        sequence: instance.acquiredSequence,
                        instanceId: instance.id,
                    })),
                ),
            )
            .sort(orderRules);
    }
}
