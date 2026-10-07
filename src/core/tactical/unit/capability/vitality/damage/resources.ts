import { type EffectInstance, type EffectInstanceValue } from "../../effects/instance.js";
import { type EffectProgramRef } from "../../effects/program.js";
import { EffectResources } from "../../effects/registry.js";
import type { EffectTransitionResources } from "../../effects/contract.js";
import { hasEffects } from "../../effects/capability.js";
import type { NumericProviderFacts } from "../../contribution.js";
import type { NumericContributionProvider } from "../../../../modifier/providers.js";
import type { Unit, UnitId } from "../../../unit.js";
import type { DamageOperands, DamageReport, DamageRequest, PendingDamage } from "./contract.js";
import { getCombatUnit, type CombatWork } from "../../../../battle/execution/work.js";

export interface DamageResourceServices extends EffectTransitionResources {
    readonly damage: Pick<DamageResources, "formulaRules" | "amountRules" | "reactionRules">;
    readonly defense: NumericContributionProvider<NumericProviderFacts>;
    readonly vitality: NumericContributionProvider<NumericProviderFacts>;
}

export interface DamageRuleContext<S extends object> {
    readonly work: CombatWork;
    readonly request: DamageRequest;
    readonly ownerUnitId: UnitId;
    readonly instance: EffectInstance<S>;
    readonly resources: DamageResourceServices;
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

export interface DamageEffectRules<S extends object> {
    readonly group?: { readonly id: string; readonly strength: number };
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
    readonly group: DamageEffectRules<object>["group"];
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

export class DamageResources {
    readonly #effects: EffectResources;
    readonly #rules = new Map<string, ProgramRules>();

    constructor(effects: EffectResources) {
        this.#effects = effects;
    }

    register<S extends object>(
        ref: EffectProgramRef<S>,
        rules: NoInfer<DamageEffectRules<S>>,
        resources: DamageResourceServices,
    ): void {
        if (this.#rules.has(ref.id)) {
            throw new TypeError(`duplicate damage effect ${ref.id}`);
        }

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

            return this.#effects.typedInstance(instance, ref);
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
                        : apply({ work, request, ownerUnitId, instance, resources }, value);
                },
            }));

        const sourceFormula = rules.sourceFormula?.map((entry) => ({ ...entry }));
        const targetFormula = rules.targetFormula?.map((entry) => ({ ...entry }));
        const output = rules.output?.map((entry) => ({ ...entry }));
        const reception = rules.reception?.map((entry) => ({ ...entry }));
        const reaction = rules.reaction?.map((entry) => ({ ...entry }));
        const stageRules = { sourceFormula, targetFormula, output, reception, reaction };

        this.#rules.set(ref.id, {
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
                                      resources,
                                  },
                                  report,
                              );
                    },
                })),
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
            .filter(
                ({ instance, rules }) =>
                    instance.participating && !instance.finished && participates(rules),
            )
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
