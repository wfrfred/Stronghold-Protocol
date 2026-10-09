import { ResourceRegistration } from "../../../../../common/resource-registration.js";
import type { EffectInstanceValue } from "../../effects/instance.js";
import type { EffectProgramRef } from "../../effects/program.js";
import type { EffectResources } from "../../effects/registry.js";
import type { EffectLifecycleOperations } from "../../effects/contract.js";
import type { UnitLifecycleResources } from "../../../../battle/execution/unit-lifecycle.js";
import type { ContributionFacts } from "../../contribution.js";
import type * as computation from "../../../../modifier/computation.js";
import type {
    VitalityHookContext,
    VitalityHookOperations,
    VitalityHookInvocation,
    DispatchResult,
} from "../hook.js";
import type { HealingOperation } from "../healing/contract.js";
import type {
    DamageOperation,
    DamageOperands,
    DamageReport,
    DamageRequest,
    PendingDamage,
} from "./contract.js";
import type { EffectSourceResources } from "../../../../battlefield/effect-source/resources.js";

export interface DamageResourceServices extends UnitLifecycleResources {
    readonly effectSources: EffectSourceResources;
    readonly damage: DamageResources;
    readonly computations: computation.Computations<ContributionFacts>;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}

export interface DamageQueryContext<S extends object> extends VitalityHookContext<S> {
    readonly request: DamageRequest;
}

export interface DamageFormulaContext<S extends object> extends DamageQueryContext<S> {
    readonly operations: { readonly effects: EffectLifecycleOperations };
}

export interface DamageRuleContext<S extends object> extends DamageQueryContext<S> {
    readonly operations: VitalityHookOperations;
}

export type DamageFormulaRule<S extends object> = (
    context: DamageFormulaContext<S>,
    value: DamageOperands,
) => DispatchResult<DamageOperands>;

export type DamageRule<S extends object, V> = (
    context: DamageRuleContext<S>,
    value: V,
) => DispatchResult<V>;

export type DamageReaction<S extends object> = (
    context: DamageRuleContext<S>,
    report: DamageReport,
) => undefined | { readonly stopDispatch?: boolean };

export interface OrderedRule<F> {
    readonly priority: number;
    readonly apply: F;
}

export interface DamageEffectRules<S extends object> {
    readonly group?: { readonly id: string; readonly strength: number };
    readonly sourceFormula?: OrderedRule<DamageFormulaRule<S>>;
    readonly targetFormula?: OrderedRule<DamageFormulaRule<S>>;
    readonly output?: OrderedRule<DamageRule<S, PendingDamage>>;
    readonly reception?: OrderedRule<DamageRule<S, PendingDamage>>;
    readonly skippedReception?: OrderedRule<DamageRule<S, PendingDamage>>;
    readonly reaction?: OrderedRule<DamageReaction<S>>;
}

export type FormulaStage = "sourceFormula" | "targetFormula";

export type AmountStage = "output" | "reception" | "skippedReception";

export type DamageHookStage = FormulaStage | AmountStage | "reaction";

export type DamageHookInvocation = VitalityHookInvocation<DamageRequest>;

type CompiledHook<V> = OrderedRule<(context: DamageHookInvocation, value: V) => DispatchResult<V>>;

type CompiledReaction = OrderedRule<
    (
        context: DamageHookInvocation,
        report: DamageReport,
    ) => undefined | { readonly stopDispatch?: boolean }
>;

export interface CompiledDamageRules {
    readonly group?: { readonly id: string; readonly strength: number };
    readonly sourceFormula?: CompiledHook<DamageOperands>;
    readonly targetFormula?: CompiledHook<DamageOperands>;
    readonly output?: CompiledHook<PendingDamage>;
    readonly reception?: CompiledHook<PendingDamage>;
    readonly skippedReception?: CompiledHook<PendingDamage>;
    readonly reaction?: CompiledReaction;
}

const emptyRules: CompiledDamageRules = Object.freeze({});

export class DamageResources {
    readonly #effects: EffectResources;
    readonly #rules = new Map<string, CompiledDamageRules>();
    readonly #registration: ResourceRegistration;

    constructor(effects: EffectResources, registration = new ResourceRegistration()) {
        this.#effects = effects;
        this.#registration = registration;
    }

    register<S extends object>(
        ref: EffectProgramRef<S>,
        rules: NoInfer<DamageEffectRules<S>>,
    ): void {
        this.#registration.assertWritable();
        this.#effects.get(ref);

        if (this.#rules.has(ref.id)) {
            throw new TypeError(`duplicate damage effect ${ref.id}`);
        }

        const effects = this.#effects;
        const contextFor = (invocation: DamageHookInvocation): DamageRuleContext<S> => ({
            ref: invocation.ref,
            ownerUnitId: invocation.ref.unitId,
            get instance() {
                return effects.typedInstance(invocation.instance, ref)!;
            },
            request: invocation.request,
            tick: invocation.tick,
            facts: invocation.facts,
            operations: invocation.operations,
        });

        const compileFormula = (rule: OrderedRule<DamageFormulaRule<S>> | undefined) => {
            if (rule === undefined) {
                return undefined;
            }

            const { priority, apply } = rule;

            return Object.freeze({
                priority,
                apply: (invocation: DamageHookInvocation, value: DamageOperands) => {
                    const context = contextFor(invocation);

                    return apply(
                        {
                            ...context,
                            get instance() {
                                return context.instance;
                            },
                            operations: { effects: context.operations.effects },
                        },
                        value,
                    );
                },
            });
        };
        const compileAmount = (rule: OrderedRule<DamageRule<S, PendingDamage>> | undefined) => {
            if (rule === undefined) {
                return undefined;
            }

            const { priority, apply } = rule;

            return Object.freeze({
                priority,
                apply: (invocation: DamageHookInvocation, value: PendingDamage) =>
                    apply(contextFor(invocation), value),
            });
        };

        const sourceFormula = compileFormula(rules.sourceFormula);
        const targetFormula = compileFormula(rules.targetFormula);
        const output = compileAmount(rules.output);
        const reception = compileAmount(rules.reception);
        const skippedReception = compileAmount(rules.skippedReception);
        const reaction = rules.reaction === undefined ? undefined : { ...rules.reaction };

        this.#rules.set(
            ref.id,
            Object.freeze({
                ...(rules.group === undefined ? {} : { group: Object.freeze({ ...rules.group }) }),
                ...(sourceFormula === undefined ? {} : { sourceFormula }),
                ...(targetFormula === undefined ? {} : { targetFormula }),
                ...(output === undefined ? {} : { output }),
                ...(reception === undefined ? {} : { reception }),
                ...(skippedReception === undefined ? {} : { skippedReception }),
                ...(reaction === undefined
                    ? {}
                    : {
                          reaction: Object.freeze({
                              priority: reaction.priority,
                              apply: (invocation: DamageHookInvocation, report: DamageReport) =>
                                  reaction.apply(contextFor(invocation), report),
                          }),
                      }),
            }),
        );
    }

    get(instance: EffectInstanceValue): CompiledDamageRules {
        this.#registration.assertUsable();

        return this.#rules.get(instance.programRef.id) ?? emptyRules;
    }
}
