import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import { ResourceRegistration } from "../../../../common/resource-registration.js";
import {
    getCombatUnit,
    transitionCombatUnit,
    type CombatWork,
} from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";
import type {
    EffectLifecycleOperations,
    EffectTransitionResources,
    EffectView,
} from "../effects/contract.js";
import { EffectDispatchScope, participatingEffect } from "../effects/dispatch.js";
import type { EffectAddress, EffectInstance, EffectInstanceValue } from "../effects/instance.js";
import { finalizeFinishedEffects } from "../effects/lifecycle.js";
import { createEffectOperations } from "../effects/operations.js";
import type { EffectProgramRef } from "../effects/program.js";
import { effectView, getEffect } from "../effects/query.js";
import type { EffectResources } from "../effects/registry.js";
import { hasAction } from "./capability.js";

export type ActionReleaseDirective =
    { readonly type: "CONTINUE" } | { readonly type: "INTERRUPT"; readonly recoveryTicks: number };

export interface ActionReleaseContext<S extends object> {
    readonly unitId: UnitId;
    readonly tick: number;
    readonly address: EffectAddress;
    readonly instance: EffectInstance<S>;
    readonly facts: EffectView;
    readonly effects: EffectLifecycleOperations;
}

export interface ActionReleaseRules<S extends object> {
    readonly beforeRelease: (context: ActionReleaseContext<S>) => ActionReleaseDirective;
}

type ActionReleaseInvocation = Omit<ActionReleaseContext<object>, "instance"> & {
    readonly instance: EffectInstanceValue;
};

export interface CompiledActionReleaseRules {
    readonly beforeRelease: (context: ActionReleaseInvocation) => ActionReleaseDirective;
}

export class ActionReleaseResources {
    readonly #effects: EffectResources;
    readonly #rules = new Map<string, CompiledActionReleaseRules>();
    readonly #registration: ResourceRegistration;

    constructor(effects: EffectResources, registration = new ResourceRegistration()) {
        this.#effects = effects;
        this.#registration = registration;
    }

    register<S extends object>(
        ref: EffectProgramRef<S>,
        rules: NoInfer<ActionReleaseRules<S>>,
    ): void {
        this.#registration.assertWritable();
        this.#effects.get(ref);

        if (this.#rules.has(ref.id)) {
            throw new TypeError(`duplicate action release effect ${ref.id}`);
        }

        const effects = this.#effects;
        const beforeRelease = rules.beforeRelease;

        this.#rules.set(
            ref.id,
            Object.freeze({
                beforeRelease: (context: ActionReleaseInvocation) =>
                    beforeRelease({
                        ...context,
                        get instance() {
                            const instance = effects.typedInstance(context.instance, ref);

                            if (instance === undefined) {
                                throw new TypeError(
                                    "action release requires its matching effect program",
                                );
                            }

                            return instance;
                        },
                    }),
            }),
        );
    }

    get(instance: EffectInstanceValue): CompiledActionReleaseRules | undefined {
        this.#registration.assertUsable();

        return this.#rules.get(instance.programRef.id);
    }
}

export function beforeActionRelease(
    input: CombatWork,
    unitId: UnitId,
    tick: number,
    resources: EffectTransitionResources & { readonly actionRelease?: ActionReleaseResources },
): { readonly work: CombatWork; readonly interrupted: boolean } {
    assertNonnegativeSafeInteger(unitId, "action release unit identity");
    assertNonnegativeSafeInteger(tick, "action release tick");

    const unit = getCombatUnit(input, unitId);
    const release = resources.actionRelease;

    if (unit === undefined || !hasAction(unit) || release === undefined) {
        return { work: input, interrupted: false };
    }

    let work = input;
    const scope = new EffectDispatchScope();
    const getWork = () => work;

    const setWork = (current: CombatWork) => {
        work = current;
    };

    const facts = effectView(getWork);

    const directive = scope.withCandidates(facts, unitId, (addresses) => {
        let latest: ActionReleaseDirective | undefined;

        for (const address of addresses) {
            const instance = participatingEffect(facts, address);
            const rules = instance === undefined ? undefined : release.get(instance);

            if (instance === undefined || rules === undefined) {
                continue;
            }

            latest = scope.withInstance(address, instance, (lastKnown) => {
                let active = true;

                const readWork = (): CombatWork => {
                    if (!active) {
                        throw new TypeError("action release context is no longer active");
                    }

                    return work;
                };

                try {
                    return rules.beforeRelease({
                        unitId,
                        tick,
                        address,
                        get instance() {
                            return getEffect(readWork(), address) ?? lastKnown();
                        },
                        facts: effectView(readWork),
                        effects: createEffectOperations(readWork, setWork, resources, tick, scope),
                    });
                } finally {
                    active = false;
                }
            });

            if (latest.type === "INTERRUPT") {
                assertNonnegativeSafeInteger(latest.recoveryTicks, "action release recovery");

                return latest;
            }
        }

        return latest;
    });

    if (directive === undefined) {
        return { work, interrupted: false };
    }

    work = finalizeFinishedEffects(work, unitId, resources, tick, scope);

    if (directive.type === "CONTINUE") {
        return { work, interrupted: false };
    }

    const recoveryUntilTick = tick + directive.recoveryTicks;
    assertNonnegativeSafeInteger(recoveryUntilTick, "action release recovery deadline");
    work = transitionCombatUnit(work, unitId, (current) => {
        if (!hasAction(current) || current.action.recoveryUntilTick >= recoveryUntilTick) {
            return current;
        }

        return {
            ...current,
            action: { ...current.action, recoveryUntilTick },
        };
    });

    return { work, interrupted: true };
}
