import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type {
    EffectAdmissionContext,
    EffectLifecycleContext,
    EffectLifecycleProgram,
} from "./contract.js";
import type { EffectInstanceValue } from "./instance.js";
import type { EffectProgramRef } from "./program.js";
import type { EffectResources } from "./registry.js";
import { hasEffects } from "./capability.js";

export interface CompiledEffectLifecycle {
    readonly start?: (context: EffectLifecycleContext) => undefined;
    readonly enable?: (context: EffectLifecycleContext) => undefined;
    readonly disable?: (context: EffectLifecycleContext) => undefined;
    readonly finalize?: (context: EffectLifecycleContext) => undefined;
    readonly accepts?: (context: EffectAdmissionContext) => boolean;
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
                          });
                      },
                  };
        const start = compile(program.start).run;
        const enable = compile(program.enable).run;
        const disable = compile(program.disable).run;
        const finalize = compile(program.finalize).run;
        const accepts = program.accepts;

        this.#programs.set(
            ref.id,
            Object.freeze({
                ...(start === undefined ? {} : { start }),
                ...(enable === undefined ? {} : { enable }),
                ...(disable === undefined ? {} : { disable }),
                ...(finalize === undefined ? {} : { finalize }),
                ...(accepts === undefined
                    ? {}
                    : {
                          accepts: (context: EffectAdmissionContext) =>
                              accepts({ ...context, instance: typed(context.instance) }),
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
    return ({ address, facts }) => {
        const unit = facts.getUnit(address.unitId);

        return (
            unit === undefined ||
            !hasEffects(unit) ||
            !unit.effects.instances.some(
                (instance) =>
                    instance.id !== address.instanceId &&
                    instance.started &&
                    !instance.finished &&
                    instance.programRef.id === key,
            )
        );
    };
}
