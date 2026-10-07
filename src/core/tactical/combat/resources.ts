import {
    EffectResources,
    type EffectInstance,
    type EffectInstanceValue,
    type EffectProgram,
    type EffectProgramRef,
} from "../effect/instance.js";
import type { NumericContribution } from "../modifier/numeric.js";
import { installEffect } from "../effect/lifecycle.js";
import type { StatusFlag } from "../unit/capability/status.js";
import {
    NumericContributionResources,
    compileNumericProviderBinding,
    compileNumericProjectionBinding,
    offenseAttackContributions,
    defenseContributions,
    resistanceContributions,
    vitalityMaxHpContributions,
    type EffectContributionProjection,
    type CompiledEffectContribution,
} from "./contributions.js";
import { createEffectsState, hasEffects, type Effects } from "../unit/capability/effects.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { DamageOperands, DamageReport, DamageRequest, PendingDamage } from "./contract.js";
import { combatWorkView, getCombatUnit, transitionCombatUnit, type CombatWork } from "./work.js";
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
    readonly contributions?: readonly EffectContributionProjection<S>[];
    readonly sourceFormula?: readonly OrderedRule<DamageRule<S, DamageOperands>>[];
    readonly targetFormula?: readonly OrderedRule<DamageRule<S, DamageOperands>>[];
    readonly output?: readonly OrderedRule<DamageRule<S, PendingDamage>>[];
    readonly reception?: readonly OrderedRule<DamageRule<S, PendingDamage>>[];
    readonly reaction?: readonly OrderedRule<DamageReaction<S>>[];
}

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
    readonly hasRules: (stage: FormulaStage | AmountStage | "reaction") => boolean;
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
    readonly offense = new NumericContributionResources();
    readonly defense = new NumericContributionResources();
    readonly vitality = new NumericContributionResources();
    readonly #rules = new Map<string, ProgramRules>();
    readonly #contributions = new Map<string, readonly CompiledEffectContribution[]>();

    registerEffect<S extends object>(
        program: EffectProgram<S>,
        rules: NoInfer<CombatEffectRules<S>>,
    ): EffectProgram<S> {
        if (this.#rules.has(program.ref.id)) {
            throw new TypeError(`duplicate combat effect ${program.ref.id}`);
        }

        this.effects.register(program);
        const group = rules.group === undefined ? undefined : Object.freeze({ ...rules.group });

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

        const compileProvider = (
            id: string,
            target: typeof offenseAttackContributions,
            providers: NumericContributionResources,
            provider: ParameterProvider<S> | undefined,
        ): CompiledEffectContribution[] =>
            provider === undefined
                ? []
                : [
                      compileNumericProviderBinding({
                          id: `parameter/${id}`,
                          target,
                          providers,
                          providerRef: `${program.ref.id}/${id}`,
                          group,
                          evaluate: ({ unit, work, entry }) => {
                              const owner = entry.owner;
                              const instance =
                                  owner === undefined
                                      ? undefined
                                      : current(work, owner.unitId, owner.instanceId);

                              return instance === undefined
                                  ? []
                                  : provider({
                                        unit,
                                        battlefield: combatWorkView(work),
                                        instance,
                                    });
                          },
                      }),
                  ];

        this.#contributions.set(program.ref.id, [
            ...compileProvider("attack", offenseAttackContributions, this.offense, rules.attack),
            ...compileProvider("defense", defenseContributions, this.defense, rules.defense),
            ...compileProvider(
                "resistance",
                resistanceContributions,
                this.defense,
                rules.resistance,
            ),
            ...compileProvider("maxHp", vitalityMaxHpContributions, this.vitality, rules.maxHp),
            ...(rules.contributions ?? []).map((projection) => {
                const { id, target, project } = projection;
                const projectionGroup =
                    projection.group === undefined ? group : Object.freeze({ ...projection.group });

                return compileNumericProjectionBinding({
                    id: `projection/${id}`,
                    target,
                    group: projectionGroup,
                    project: (instance) => {
                        const typed = this.effects.typedInstance(instance, program.ref);

                        if (typed === undefined) {
                            throw new TypeError(
                                "contribution projection requires its matching effect program",
                            );
                        }

                        return project(typed);
                    },
                });
            }),
        ]);
        const sourceFormula = rules.sourceFormula?.map((entry) => ({ ...entry }));
        const targetFormula = rules.targetFormula?.map((entry) => ({ ...entry }));
        const output = rules.output?.map((entry) => ({ ...entry }));
        const reception = rules.reception?.map((entry) => ({ ...entry }));
        const reaction = rules.reaction?.map((entry) => ({ ...entry }));
        const stageRules = { sourceFormula, targetFormula, output, reception, reaction };

        this.#rules.set(program.ref.id, {
            group,
            hasRules: (stage) => (stageRules[stage]?.length ?? 0) > 0,
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

    installEffect<U extends Unit>(
        unit: U,
        instance: EffectInstanceValue,
        flags: readonly StatusFlag[] = [],
    ): U & Effects {
        const bindings = this.#effectContributions(instance);
        let installed = installEffect(unit, instance, flags);

        for (const binding of bindings) {
            installed = binding.install(installed, instance);
        }

        return installed;
    }

    cleanupContributions<U extends Unit>(
        unit: U,
        removedInstances: readonly EffectInstanceValue[],
    ): U {
        let current = unit;

        for (const instance of removedInstances) {
            for (const binding of this.#effectContributions(instance)) {
                current = binding.remove(current, instance);
            }
        }

        return current;
    }

    #effectContributions(instance: EffectInstanceValue): readonly CompiledEffectContribution[] {
        const bindings = this.#contributions.get(instance.programRef.id);

        if (bindings === undefined) {
            throw new TypeError(`unregistered combat effect ${instance.programRef.id}`);
        }

        return bindings;
    }

    updateEffectState<S extends object>(
        work: CombatWork,
        ownerUnitId: UnitId,
        instanceId: number,
        ref: EffectProgramRef<S>,
        state: NoInfer<S> | ((current: NoInfer<S>) => NoInfer<S>),
    ): CombatWork {
        return transitionCombatUnit(work, ownerUnitId, (owner) => {
            if (!hasEffects(owner)) {
                return owner;
            }

            const instance = owner.effects.instances.find((value) => value.id === instanceId);

            if (instance === undefined) {
                return owner;
            }

            const typed = this.effects.typedInstance(instance, ref);

            if (typed === undefined) {
                throw new TypeError("effect state update must use its matching program");
            }

            const updated = this.effects.update(
                instance,
                ref,
                typeof state === "function" ? state(typed.state) : state,
            );

            if (updated === instance) {
                return owner;
            }

            let unit: Unit & Effects = {
                ...owner,
                effects: createEffectsState(
                    owner.effects.instances.map((value) => (value === instance ? updated : value)),
                ),
            };

            for (const binding of this.#effectContributions(updated)) {
                unit = binding.update(unit, updated);
            }

            return unit;
        });
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
