import { ResourceRegistration } from "../../../../../common/resource-registration.js";
import type { EffectTransitionResources } from "../../effects/contract.js";
import type { EffectInstanceValue } from "../../effects/instance.js";
import type { EffectProgramRef } from "../../effects/program.js";
import type { EffectResources } from "../../effects/registry.js";
import type { NumericProviderFacts } from "../../contribution.js";
import type { NumericContributionProvider } from "../../../../modifier/providers.js";
import type {
    DamageOperation,
    DispatchResult,
    HealingOperation,
    VitalityHookContext,
    VitalityHookOperations,
    VitalityHookInvocation,
} from "../hook.js";
import type { HealingReport, HealingRequest, PendingHealing } from "./contract.js";
import type { EffectSourceResources } from "../../../../battlefield/effect-source/resources.js";

export interface HealingResourceServices extends EffectTransitionResources {
    readonly effectSources: EffectSourceResources;
    readonly vitality: NumericContributionProvider<NumericProviderFacts>;
    readonly healing: HealingResources;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}

export interface HealingRuleContext<S extends object> extends VitalityHookContext<S> {
    readonly request: HealingRequest;
    readonly operations: VitalityHookOperations;
}

export type HealingRule<S extends object> = (
    context: HealingRuleContext<S>,
    pending: PendingHealing,
) => DispatchResult<PendingHealing>;

export type HealingReaction<S extends object> = (
    context: HealingRuleContext<S>,
    report: HealingReport,
) => undefined | { readonly stopDispatch?: boolean };

export interface OrderedHealingRule<F> {
    readonly priority: number;
    readonly apply: F;
}

export interface HealingEffectRules<S extends object> {
    readonly output?: OrderedHealingRule<HealingRule<S>>;
    readonly reception?: OrderedHealingRule<HealingRule<S>>;
    readonly skippedReception?: OrderedHealingRule<HealingRule<S>>;
    readonly reaction?: OrderedHealingRule<HealingReaction<S>>;
}

export type HealingStage = "output" | "reception" | "skippedReception";

export type CompiledHealingContext = VitalityHookInvocation<HealingRequest>;

type CompiledHealingRule = (
    context: CompiledHealingContext,
    pending: PendingHealing,
) => DispatchResult<PendingHealing>;

type CompiledHealingReaction = (
    context: CompiledHealingContext,
    report: HealingReport,
) => undefined | { readonly stopDispatch?: boolean };

export interface CompiledHealingRules {
    readonly output?: OrderedHealingRule<CompiledHealingRule>;
    readonly reception?: OrderedHealingRule<CompiledHealingRule>;
    readonly skippedReception?: OrderedHealingRule<CompiledHealingRule>;
    readonly reaction?: OrderedHealingRule<CompiledHealingReaction>;
}

const emptyRules: CompiledHealingRules = Object.freeze({});

export class HealingResources {
    readonly #effects: EffectResources;
    readonly #rules = new Map<string, CompiledHealingRules>();
    readonly #registration: ResourceRegistration;

    constructor(effects: EffectResources, registration = new ResourceRegistration()) {
        this.#effects = effects;
        this.#registration = registration;
    }

    register<S extends object>(
        ref: EffectProgramRef<S>,
        rules: NoInfer<HealingEffectRules<S>>,
    ): void {
        this.#registration.assertWritable();
        this.#effects.get(ref);

        if (this.#rules.has(ref.id)) {
            throw new TypeError(`duplicate healing effect ${ref.id}`);
        }

        const effects = this.#effects;
        const contextFor = (context: CompiledHealingContext): HealingRuleContext<S> => ({
            ...context,
            get instance() {
                const instance = effects.typedInstance(context.instance, ref);

                if (instance === undefined) {
                    throw new TypeError("healing hook requires its matching program");
                }

                return instance;
            },
        });

        const compile = (entry: OrderedHealingRule<HealingRule<S>> | undefined) => {
            if (entry === undefined) {
                return undefined;
            }

            const { priority, apply } = entry;

            return Object.freeze({
                priority,
                apply: (context: CompiledHealingContext, pending: PendingHealing) =>
                    apply(contextFor(context), pending),
            });
        };

        const output = compile(rules.output);
        const reception = compile(rules.reception);
        const skippedReception = compile(rules.skippedReception);
        const reaction = rules.reaction === undefined ? undefined : { ...rules.reaction };

        this.#rules.set(
            ref.id,
            Object.freeze({
                ...(output === undefined ? {} : { output }),
                ...(reception === undefined ? {} : { reception }),
                ...(skippedReception === undefined ? {} : { skippedReception }),
                ...(reaction === undefined
                    ? {}
                    : {
                          reaction: Object.freeze({
                              priority: reaction.priority,
                              apply: (context: CompiledHealingContext, report: HealingReport) =>
                                  reaction.apply(contextFor(context), report),
                          }),
                      }),
            }),
        );
    }

    get(instance: EffectInstanceValue): CompiledHealingRules {
        this.#registration.assertUsable();

        return this.#rules.get(instance.programRef.id) ?? emptyRules;
    }
}
