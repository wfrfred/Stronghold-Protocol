import type * as contribution from "../../../modifier/contribution.js";
import type * as modifier from "../../../modifier/value.js";
import type * as computation from "../../../modifier/computation.js";
import type { Unit } from "../../unit.js";
import type { CombatTargetingView } from "../../targeting/query.js";
import type {
    ContributionTarget,
    StoredContributionTarget,
    ContributionFacts,
} from "../contribution.js";
import { hasEffects } from "./capability.js";
import { compileComputedBinding, compileStoredBinding, type EffectBinding } from "./binding.js";
import type { EffectInstance } from "./instance.js";
import type { EffectProgram } from "./program.js";
import type { EffectResources } from "./registry.js";

export interface Context<S extends object> {
    readonly unit: Unit;
    readonly battlefield: CombatTargetingView;
    readonly instance: EffectInstance<S>;
}

export interface Options {
    readonly id?: string;
    readonly group?: contribution.Group;
}

interface ContributionDeclaration {
    readonly id: string;
    readonly group?: contribution.Group;
}

export interface Stored<S extends object> extends ContributionDeclaration {
    readonly target: StoredContributionTarget;
    readonly sample: (instance: EffectInstance<S>) => readonly modifier.Value[];
}

export interface Computed<S extends object> extends ContributionDeclaration {
    readonly target: ContributionTarget;
    readonly compute: (context: Context<S>) => readonly modifier.Value[];
}

export type Definition<S extends object> = Stored<S> | Computed<S>;

export interface Resources {
    readonly effects: Pick<EffectResources, "typedInstance">;
    readonly computations: Pick<computation.Resources<ContributionFacts>, "register">;
}

export function compile<S extends object>(
    program: EffectProgram<S>,
    declarations: readonly Definition<NoInfer<S>>[],
    resources: Resources,
): readonly EffectBinding[] {
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
        const group =
            declaration.group === undefined ? undefined : Object.freeze({ ...declaration.group });

        if ("sample" in declaration) {
            const { sample } = declaration;

            return compileStoredBinding({
                id: `projection/${id}`,
                target,
                group,
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

        const { compute } = declaration;

        return compileComputedBinding({
            id: `parameter/${id}`,
            target: declaration.target,
            computations: resources.computations,
            computeRef: JSON.stringify([program.ref.id, id]),
            group,
            compute: ({ unit, battlefield }, entry) => {
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

                return instance === undefined ? [] : compute({ unit, battlefield, instance });
            },
        });
    });
}
