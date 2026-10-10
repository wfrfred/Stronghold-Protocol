import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type {
    EffectAdmissionContext,
    EffectFinishContext,
    EffectLifecycleContext,
    EffectLifecycleDefinition,
    EffectCompetition,
} from "./contract.js";
import type { EffectValue } from "./effect.js";
import type { EffectDefinitionRef } from "./definition.js";
import type { EffectResources } from "./registry.js";
import { hasEffects } from "./capability.js";

export interface CompiledEffectLifecycle {
    readonly start?: (context: EffectLifecycleContext) => undefined;
    readonly enable?: (context: EffectLifecycleContext) => undefined;
    readonly disable?: (context: EffectLifecycleContext) => undefined;
    readonly advance?: (context: EffectLifecycleContext) => undefined;
    readonly expire?: (context: EffectLifecycleContext) => undefined;
    readonly finish?: (context: EffectFinishContext) => undefined;
    readonly accepts?: (context: EffectAdmissionContext) => boolean;
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
        ref: EffectDefinitionRef<S>,
        definition: NoInfer<EffectLifecycleDefinition<S>>,
    ): void {
        this.#registration.assertWritable();
        this.#effects.get(ref);

        if (this.#definitions.has(ref.id)) {
            throw new TypeError(`duplicate effect lifecycle ${ref.id}`);
        }

        const typed = (instance: EffectValue) => {
            const value = this.#effects.typedEffect(instance, ref);

            if (value === undefined) {
                throw new TypeError("effect lifecycle requires its matching definition");
            }

            return value;
        };

        const compile = (action: EffectLifecycleDefinition<S>["start"]) =>
            action === undefined
                ? {}
                : {
                      run: (context: EffectLifecycleContext): undefined => {
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
        const start = compile(definition.start).run;
        const enable = compile(definition.enable).run;
        const disable = compile(definition.disable).run;
        const advance = compile(definition.advance).run;
        const expire = compile(definition.expire).run;
        const finishAction = definition.finish;

        const finish =
            finishAction === undefined
                ? undefined
                : (context: EffectFinishContext): undefined => {
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

        const accepts = definition.accepts;
        const competition = definition.competition;

        this.#definitions.set(
            ref.id,
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
                          accepts: (context: EffectAdmissionContext) =>
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

        return this.#definitions.get(instance.definitionRef.id) ?? emptyLifecycle;
    }
}

export function uniqueEffectAdmission(
    key: string,
): NonNullable<EffectLifecycleDefinition<object>["accepts"]> {
    return ({ unitId, facts }) => {
        const unit = facts.getUnit(unitId);

        return (
            unit === undefined ||
            !hasEffects(unit) ||
            !unit.effects.instances.some(
                (instance) => !instance.finished && instance.definitionRef.id === key,
            )
        );
    };
}
