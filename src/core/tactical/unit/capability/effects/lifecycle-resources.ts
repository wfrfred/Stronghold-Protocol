import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type {
    EffectAdmissionContext,
    EffectFinishContext,
    EffectLifecycleContext,
    EffectLifecycleProgram,
    EffectCompetition,
} from "./contract.js";
import type { EffectInstanceValue } from "./instance.js";
import type { EffectProgramRef } from "./program.js";
import type { EffectResources } from "./registry.js";
import { hasEffects } from "./capability.js";

export interface CompiledEffectLifecycle {
    readonly start?: (context: EffectLifecycleContext) => undefined;
    readonly enable?: (context: EffectLifecycleContext) => undefined;
    readonly disable?: (context: EffectLifecycleContext) => undefined;
    readonly advance?: (context: EffectLifecycleContext) => undefined;
    readonly reconcile?: (context: EffectLifecycleContext) => undefined;
    readonly expire?: (context: EffectLifecycleContext) => undefined;
    readonly finish?: (context: EffectFinishContext) => undefined;
    readonly accepts?: (context: EffectAdmissionContext) => boolean;
    readonly competition?: (instance: EffectInstanceValue) => EffectCompetition | undefined;
}

const emptyLifecycle: CompiledEffectLifecycle = Object.freeze({});

export class EffectLifecycleResources {
    readonly #effects: EffectResources;
    readonly #programs = new Map<string, CompiledEffectLifecycle>();
    readonly #registration: ResourceRegistration;

    constructor(effects: EffectResources, registration = new ResourceRegistration()) {
        this.#effects = effects;
        this.#registration = registration;
    }

    register<S extends object>(
        ref: EffectProgramRef<S>,
        program: NoInfer<EffectLifecycleProgram<S>>,
    ): void {
        this.#registration.assertWritable();
        this.#effects.get(ref);

        if (this.#programs.has(ref.id)) {
            throw new TypeError(`duplicate effect lifecycle ${ref.id}`);
        }

        const typed = (instance: EffectInstanceValue) => {
            const value = this.#effects.typedInstance(instance, ref);

            if (value === undefined) {
                throw new TypeError("effect lifecycle requires its matching program");
            }

            return value;
        };

        const compile = (action: EffectLifecycleProgram<S>["start"]) =>
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
        const start = compile(program.start).run;
        const enable = compile(program.enable).run;
        const disable = compile(program.disable).run;
        const advance = compile(program.advance).run;
        const reconcile = compile(program.reconcile).run;
        const expire = compile(program.expire).run;
        const finishAction = program.finish;

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

        const accepts = program.accepts;
        const competition = program.competition;

        this.#programs.set(
            ref.id,
            Object.freeze({
                ...(start === undefined ? {} : { start }),
                ...(enable === undefined ? {} : { enable }),
                ...(disable === undefined ? {} : { disable }),
                ...(advance === undefined ? {} : { advance }),
                ...(reconcile === undefined ? {} : { reconcile }),
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
                          competition: (instance: EffectInstanceValue) =>
                              competition(typed(instance)),
                      }),
            }),
        );
    }

    get(instance: EffectInstanceValue): CompiledEffectLifecycle {
        this.#registration.assertUsable();

        return this.#programs.get(instance.programRef.id) ?? emptyLifecycle;
    }
}

export function uniqueEffectAdmission(
    key: string,
): NonNullable<EffectLifecycleProgram<object>["accepts"]> {
    return ({ unitId, facts }) => {
        const unit = facts.getUnit(unitId);

        return (
            unit === undefined ||
            !hasEffects(unit) ||
            !unit.effects.instances.some(
                (instance) => !instance.finished && instance.programRef.id === key,
            )
        );
    };
}
