import type * as contribution from "../../../modifier/contribution.js";
import type * as modifier from "../../../modifier/value.js";
import type * as computation from "../../../modifier/computation.js";
import type * as numeric from "../contribution.js";
import { hasEffects } from "./capability.js";
import * as binding from "./binding.js";
import type { EffectInstance, EffectInstanceValue } from "./instance.js";
import type { EffectProgram } from "./program.js";
import type { EffectResources } from "./registry.js";

export interface Context<S extends object> extends numeric.Context {
    readonly instance: EffectInstance<S>;
}

export interface Options<S extends object = object> {
    readonly id?: string;
    readonly group?:
        contribution.Group | ((instance: EffectInstance<S>) => contribution.Group | undefined);
}

interface Declaration<S extends object> {
    readonly id: string;
    readonly group?: Options<S>["group"];
}

export interface Sampled<S extends object> extends Declaration<S> {
    readonly kind: "SAMPLED";
    readonly target: numeric.SampledTarget;
    readonly sample: (instance: EffectInstance<S>) => readonly modifier.Value[];
    readonly reconcile?: binding.Binding["reconcile"];
}

export interface Live<S extends object> extends Declaration<S> {
    readonly kind: "LIVE";
    readonly target: numeric.Target;
    readonly evaluate: (context: Context<S>) => readonly modifier.Value[];
}

export type Definition<S extends object> = Sampled<S> | Live<S>;

export interface Resources {
    readonly effects: Pick<EffectResources, "typedInstance">;
    readonly computations: Pick<computation.Resources<numeric.Context>, "register">;
}

export function compile<S extends object>(
    program: EffectProgram<S>,
    declarations: readonly Definition<NoInfer<S>>[],
    resources: Resources,
): readonly binding.Binding[] {
    const ids = new Set<string>();

    for (const { id } of declarations) {
        if (id.length === 0) {
            throw new TypeError("effect contribution identity must be nonempty");
        }
        if (ids.has(id)) {
            throw new TypeError(`duplicate effect contribution ${program.ref.id}/${id}`);
        }

        ids.add(id);
    }

    return declarations.map((declaration) => {
        const { id, target } = declaration;
        const declaredGroup = declaration.group;

        const group =
            typeof declaredGroup !== "function"
                ? declaredGroup
                : (instance: EffectInstanceValue) => {
                      const typed = resources.effects.typedInstance(instance, program.ref);

                      if (typed === undefined) {
                          throw new TypeError(
                              "contribution group requires its matching effect program",
                          );
                      }

                      return declaredGroup(typed);
                  };

        if (declaration.kind === "SAMPLED") {
            const { sample } = declaration;

            return binding.sampled({
                id: `projection/${id}`,
                target,
                group,
                ...(declaration.reconcile === undefined
                    ? {}
                    : { reconcile: declaration.reconcile }),
                sample: (instance) => {
                    const typed = resources.effects.typedInstance(instance, program.ref);

                    if (typed === undefined) {
                        throw new TypeError(
                            "contribution projection requires its matching effect program",
                        );
                    }

                    return sample(typed);
                },
            });
        }

        const { evaluate } = declaration;

        return binding.live({
            id: `parameter/${id}`,
            target: declaration.target,
            computations: resources.computations,
            evaluator: JSON.stringify([program.ref.id, id]),
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

                return instance === undefined ? [] : evaluate({ unit, battlefield, instance });
            },
        });
    });
}
