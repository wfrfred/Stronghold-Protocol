import type { EffectResources } from "./registry.js";
import { type EffectInstance, type EffectInstanceValue } from "./instance.js";
import { type EffectProgram, type EffectProgramRef } from "./program.js";
import { hasEffects } from "./capability.js";
import {
    compileNumericProviderBinding,
    compileNumericProjectionBinding,
    type EffectContributionProjection,
    type CompiledEffectContribution,
} from "./contribution-bindings.js";
import type { NumericContribution } from "../../../modifier/numeric.js";
import type { NumericContributionResources } from "../../../modifier/providers.js";
import { offenseAttackContributions } from "../offense/capability.js";
import { defenseContributions, resistanceContributions } from "../defense/capability.js";
import { vitalityMaxHpContributions } from "../vitality/capability.js";
import type { NumericContributionTarget, NumericProviderFacts } from "../contribution.js";
import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { Unit } from "../../unit.js";
import type { CombatTargetingView } from "../../targeting/query.js";

export interface ParameterContext<S extends object> {
    readonly unit: Unit;
    readonly battlefield: CombatTargetingView;
    readonly instance: EffectInstance<S>;
}

export type ParameterProvider<S extends object> = (
    context: ParameterContext<S>,
) => readonly NumericContribution[];

export interface EffectContributionRules<S extends object> {
    readonly group?: { readonly id: string; readonly strength: number };
    readonly attack?: ParameterProvider<S>;
    readonly defense?: ParameterProvider<S>;
    readonly resistance?: ParameterProvider<S>;
    readonly maxHp?: ParameterProvider<S>;
    readonly contributions?: readonly EffectContributionProjection<S>[];
}

export interface EffectContributionResources {
    readonly effects: EffectResources;
    readonly offense: NumericContributionResources<NumericProviderFacts>;
    readonly defense: NumericContributionResources<NumericProviderFacts>;
    readonly vitality: NumericContributionResources<NumericProviderFacts>;
}

export function compileEffectContributions<S extends object>(
    program: EffectProgram<S>,
    rules: NoInfer<EffectContributionRules<S>>,
    resources: EffectContributionResources,
): readonly CompiledEffectContribution[] {
    const group = rules.group === undefined ? undefined : Object.freeze({ ...rules.group });
    const compileProvider = (
        id: string,
        target: NumericContributionTarget,
        providers: NumericContributionResources<NumericProviderFacts>,
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
                                  : resources.effects.typedInstance(value, program.ref);

                          return instance === undefined
                              ? []
                              : provider({ unit, battlefield, instance });
                      },
                  }),
              ];

    return [
        ...compileProvider("attack", offenseAttackContributions, resources.offense, rules.attack),
        ...compileProvider("defense", defenseContributions, resources.defense, rules.defense),
        ...compileProvider(
            "resistance",
            resistanceContributions,
            resources.defense,
            rules.resistance,
        ),
        ...compileProvider("maxHp", vitalityMaxHpContributions, resources.vitality, rules.maxHp),
        ...(rules.contributions ?? []).map((projection) => {
            const { id, target, project } = projection;
            const projectionGroup =
                projection.group === undefined ? group : Object.freeze({ ...projection.group });

            return compileNumericProjectionBinding({
                id: `projection/${id}`,
                target,
                group: projectionGroup,
                project: (instance) => {
                    const typed = resources.effects.typedInstance(instance, program.ref);

                    if (typed === undefined) {
                        throw new TypeError(
                            "contribution projection requires its matching effect program",
                        );
                    }

                    return project(typed);
                },
            });
        }),
    ];
}

export interface EffectContributionBindings {
    get(instance: EffectInstanceValue): readonly CompiledEffectContribution[];
}

export class EffectBindingResources implements EffectContributionBindings {
    readonly #contributions = new Map<string, readonly CompiledEffectContribution[]>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register<S extends object>(
        ref: EffectProgramRef<S>,
        bindings: readonly CompiledEffectContribution[],
    ): void {
        this.#registration.assertWritable();

        if (this.#contributions.has(ref.id)) {
            throw new TypeError(`duplicate effect bindings ${ref.id}`);
        }

        const owned = Object.freeze(
            bindings.map(({ install, update, setParticipation, remove }) =>
                Object.freeze({ install, update, setParticipation, remove }),
            ),
        );
        this.#contributions.set(ref.id, owned);
    }

    get(instance: EffectInstanceValue): readonly CompiledEffectContribution[] {
        this.#registration.assertUsable();
        const bindings = this.#contributions.get(instance.programRef.id);

        if (bindings === undefined) {
            throw new TypeError(`unregistered effect bindings ${instance.programRef.id}`);
        }

        return bindings;
    }
}
