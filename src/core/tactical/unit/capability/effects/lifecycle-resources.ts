import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type {
    EffectAdmissionContext,
    EffectFinishContext,
    EffectLifecycleContext,
    EffectLifecycleDefinition,
    EffectCompetition,
} from "./contract.js";
import type { EffectValue } from "./effect.js";
import type { EffectDefinition } from "./definition.js";
import type { EffectResources } from "./registry.js";
import { hasEffects } from "./capability.js";

export type EffectLifecycleInvocation = Omit<EffectLifecycleContext, "instance"> & {
    readonly instance: EffectValue;
};

type EffectFinishInvocation = Omit<EffectFinishContext, "instance"> & {
    readonly instance: EffectValue;
};

type EffectAdmissionInvocation = Omit<EffectAdmissionContext, "instance"> & {
    readonly instance: EffectValue;
};

export interface CompiledEffectLifecycle {
    readonly start?: (context: EffectLifecycleInvocation) => undefined;
    readonly enable?: (context: EffectLifecycleInvocation) => undefined;
    readonly disable?: (context: EffectLifecycleInvocation) => undefined;
    readonly advance?: (context: EffectLifecycleInvocation) => undefined;
    readonly expire?: (context: EffectLifecycleInvocation) => undefined;
    readonly finish?: (context: EffectFinishInvocation) => undefined;
    readonly accepts?: (context: EffectAdmissionInvocation) => boolean;
    readonly competition?: (instance: EffectValue) => EffectCompetition | undefined;
}

const emptyLifecycle: CompiledEffectLifecycle = Object.freeze({});

export class EffectLifecycleResources {
    readonly #effects: EffectResources;
    readonly #definitions = new Map<string, CompiledEffectLifecycle>();
    readonly #registration: ResourceRegistration;

    constructor(effects: EffectResources, registration = new ResourceRegistration()) {
        this.#effects = effects;
        this.#registration = registration;
    }

    register<S extends object>(
        definition: EffectDefinition<S>,
        lifecycle: NoInfer<EffectLifecycleDefinition<S>>,
    ): void {
        this.#registration.assertWritable();
        this.#effects.get(definition);

        if (this.#definitions.has(definition.id)) {
            throw new TypeError(`duplicate effect lifecycle ${definition.id}`);
        }

        const typed = (instance: EffectValue) => {
            const value = this.#effects.typedEffect(instance, definition);

            if (value === undefined) {
                throw new TypeError("effect lifecycle requires its matching definition");
            }

            return value;
        };

        const compile = (action: EffectLifecycleDefinition<S>["start"]) =>
            action === undefined
                ? {}
                : {
                      run: (context: EffectLifecycleInvocation): undefined => {
                          action({
                              ...context,
                              get instance() {
                                  return typed(context.instance);
                              },
                              get battlefield() {
                                  return context.battlefield;
                              },
                          });
                      },
                  };
        const start = compile(lifecycle.start).run;
        const enable = compile(lifecycle.enable).run;
        const disable = compile(lifecycle.disable).run;
        const advance = compile(lifecycle.advance).run;
        const expire = compile(lifecycle.expire).run;
        const finishAction = lifecycle.finish;

        const finish =
            finishAction === undefined
                ? undefined
                : (context: EffectFinishInvocation): undefined => {
                      finishAction({
                          ...context,
                          get instance() {
                              return typed(context.instance);
                          },
                          get battlefield() {
                              return context.battlefield;
                          },
                      });
                  };

        const accepts = lifecycle.accepts;
        const competition = lifecycle.competition;

        this.#definitions.set(
            definition.id,
            Object.freeze({
                ...(start === undefined ? {} : { start }),
                ...(enable === undefined ? {} : { enable }),
                ...(disable === undefined ? {} : { disable }),
                ...(advance === undefined ? {} : { advance }),
                ...(expire === undefined ? {} : { expire }),
                ...(finish === undefined ? {} : { finish }),
                ...(accepts === undefined
                    ? {}
                    : {
                          accepts: (context: EffectAdmissionInvocation) =>
                              accepts({ ...context, instance: typed(context.instance) }),
                      }),
                ...(competition === undefined
                    ? {}
                    : {
                          competition: (instance: EffectValue) => competition(typed(instance)),
                      }),
            }),
        );
    }

    get(instance: EffectValue): CompiledEffectLifecycle {
        this.#registration.assertUsable();

        return this.#definitions.get(instance.definition.id) ?? emptyLifecycle;
    }
}

export function uniqueEffectAdmission(
    key: string,
): NonNullable<CompiledEffectLifecycle["accepts"]> {
    return ({ unitId, facts }) => {
        const unit = facts.getUnit(unitId);

        return (
            unit === undefined ||
            !hasEffects(unit) ||
            !unit.effects.instances.some(
                (instance) => !instance.finished && instance.definition.id === key,
            )
        );
    };
}
