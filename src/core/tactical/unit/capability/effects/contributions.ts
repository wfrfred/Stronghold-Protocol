import type { Contribution, Group, Input } from "../../../contribution/contribution.js";
import type { Value } from "../../../contribution/value.js";
import type { QueryContext } from "../../query.js";
import { hasEffects } from "./capability.js";
import type { Binding } from "./binding.js";
import type { Effect, EffectValue } from "./effect.js";
import type { EffectDefinition } from "./definition.js";
import type { EffectResources } from "./registry.js";
import type { StableUnit, Unit } from "../../unit.js";

type Set<V> = <U extends Unit>(
    unit: U | StableUnit<U>,
    contribution: Contribution<V>,
) => StableUnit<U>;

type Remove = <U extends Unit>(unit: U | StableUnit<U>, id: string) => StableUnit<U>;

export interface Context<S extends object> extends QueryContext {
    readonly instance: Effect<S>;
}

export interface Options<S extends object = object> {
    readonly id?: string;
    readonly group?: Group | ((instance: Effect<S>) => Group | undefined);
}

interface Declaration<S extends object> {
    readonly id: string;
    readonly group?: Options<S>["group"];
    readonly remove: Remove;
}

export interface Sampled<S extends object> extends Declaration<S> {
    readonly kind: "SAMPLED";
    readonly set: Set<readonly Value[]>;
    readonly sample: (instance: Effect<S>) => readonly Value[];
}

export interface Live<S extends object> extends Declaration<S> {
    readonly kind: "LIVE";
    readonly set: Set<Input<QueryContext>>;
    readonly evaluate: (context: Context<S>) => readonly Value[];
}

export type Definition<S extends object> = Sampled<S> | Live<S>;

function binding<V>(
    id: string,
    set: Set<V>,
    remove: Remove,
    create: (instance: EffectValue) => Contribution<V>,
): Binding {
    const update: Binding["update"] = (unit, instance) =>
        instance.participating
            ? set(unit, create(instance))
            : remove(unit, `@effect/${instance.id}/${id}`);

    return {
        install: update,
        update,
        setParticipation: (unit, instance, participating) =>
            participating
                ? set(unit, create(instance))
                : remove(unit, `@effect/${instance.id}/${id}`),
        remove: (unit, instance) => remove(unit, `@effect/${instance.id}/${id}`),
    };
}

export function compile<S extends object>(
    definition: EffectDefinition<S>,
    declarations: readonly Definition<NoInfer<S>>[],
    resources: { readonly effects: EffectResources },
): readonly Binding[] {
    const ids = new Set<string>();

    for (const { id } of declarations) {
        if (id.length === 0 || ids.has(id)) {
            throw new TypeError(
                `effect contribution identity must be unique: ${definition.id}/${id}`,
            );
        }

        ids.add(id);
    }

    return declarations.map((declaration) => {
        const fields = (value: EffectValue) => {
            const instance = resources.effects.typedEffect(value, definition)!;
            const group =
                typeof declaration.group === "function"
                    ? declaration.group(instance)
                    : declaration.group;

            return {
                instance,
                id: `@effect/${instance.id}/${declaration.id}`,
                ...(group === undefined ? {} : { group }),
            };
        };

        if (declaration.kind === "SAMPLED") {
            return binding(declaration.id, declaration.set, declaration.remove, (instance) => {
                const { instance: typed, ...identity } = fields(instance);

                return { ...identity, value: declaration.sample(typed) };
            });
        }

        return binding(declaration.id, declaration.set, declaration.remove, (instance) => {
            const { instance: typed, ...identity } = fields(instance);
            const effectId = typed.id;

            return {
                ...identity,
                value: ({ unit, battlefield }: QueryContext) => {
                    const value = hasEffects(unit)
                        ? unit.effects.instances.find((effect) => effect.id === effectId)
                        : undefined;
                    const current =
                        value === undefined
                            ? undefined
                            : resources.effects.typedEffect(value, definition);

                    return current === undefined
                        ? []
                        : declaration.evaluate({ unit, battlefield, instance: current });
                },
            };
        });
    });
}
