import { ResourceRegistration } from "../../../../../common/resource-registration.js";
import type { EffectTransitionResources } from "../../effects/contract.js";
import type { EffectValue } from "../../effects/effect.js";
import type { EffectDefinition } from "../../effects/definition.js";
import type { EffectResources } from "../../effects/registry.js";
import type {
    DispatchResult,
    VitalityHookContext,
    VitalityHookOperations,
    VitalityHookInvocation,
} from "../hook.js";
import type { DamageOperation } from "../damage/contract.js";
import type {
    HealingOperation,
    HealingReport,
    HealingRequest,
    PendingHealing,
} from "./contract.js";

export interface HealingResourceServices extends EffectTransitionResources {
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
        definition: EffectDefinition<S>,
        rules: NoInfer<HealingEffectRules<S>>,
    ): void {
        this.#registration.assertWritable();
        this.#effects.get(definition);

        if (this.#rules.has(definition.id)) {
            throw new TypeError(`duplicate healing effect ${definition.id}`);
        }

        const effects = this.#effects;
        const contextFor = (context: CompiledHealingContext): HealingRuleContext<S> => ({
            ...context,
            get instance() {
                const instance = effects.typedEffect(context.instance, definition);

                if (instance === undefined) {
                    throw new TypeError("healing hook requires its matching definition");
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
            definition.id,
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

    get(instance: EffectValue): CompiledHealingRules {
        this.#registration.assertUsable();

        return this.#rules.get(instance.definition.id) ?? emptyRules;
    }
}
