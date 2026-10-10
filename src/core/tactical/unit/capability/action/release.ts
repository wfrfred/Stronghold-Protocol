import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import { ResourceRegistration } from "../../../../common/resource-registration.js";
import { getUnit, transitionUnit, type BattleState } from "../../../battle/execution/context.js";
import type { UnitId } from "../../unit.js";
import type {
    EffectLifecycleOperations,
    EffectTransitionResources,
    EffectView,
} from "../effects/contract.js";
import { EffectDispatchScope, participatingEffect } from "../effects/dispatch.js";
import type { EffectRef, EffectInstance, EffectInstanceValue } from "../effects/instance.js";
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
    readonly ref: EffectRef;
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
    state: BattleState,
    unitId: UnitId,
    tick: number,
    resources: EffectTransitionResources & { readonly actionRelease?: ActionReleaseResources },
    dispatch?: EffectDispatchScope,
): boolean {
    assertNonnegativeSafeInteger(unitId, "action release unit identity");
    assertNonnegativeSafeInteger(tick, "action release tick");

    const unit = getUnit(state, unitId);
    const release = resources.actionRelease;

    if (unit === undefined || !hasAction(unit) || release === undefined) {
        return false;
    }

    const scope = dispatch ?? new EffectDispatchScope();
    const facts = effectView(() => state);

    const directive = scope.withCandidates(facts, unitId, (addresses) => {
        let latest: ActionReleaseDirective | undefined;

        for (const ref of addresses) {
            const instance = participatingEffect(facts, ref);
            const rules = instance === undefined ? undefined : release.get(instance);

            if (instance === undefined || rules === undefined) {
                continue;
            }

            latest = scope.withInstance(ref, instance, (lastKnown) => {
                let active = true;

                const readState = (): BattleState => {
                    if (!active) {
                        throw new TypeError("action release context is no longer active");
                    }

                    return state;
                };

                try {
                    return rules.beforeRelease({
                        unitId,
                        tick,
                        ref,
                        get instance() {
                            return getEffect(readState(), ref) ?? lastKnown();
                        },
                        facts: effectView(readState),
                        effects: createEffectOperations(readState, resources, tick, scope),
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
        return false;
    }

    finalizeFinishedEffects(state, unitId, resources, tick, scope);

    if (directive.type === "CONTINUE") {
        return false;
    }

    const recoveryUntilTick = tick + directive.recoveryTicks;
    assertNonnegativeSafeInteger(recoveryUntilTick, "action release recovery deadline");
    transitionUnit(state, unitId, (current) => {
        if (!hasAction(current) || current.action.recoveryUntilTick >= recoveryUntilTick) {
            return current;
        }

        return {
            ...current,
            action: { ...current.action, recoveryUntilTick },
        };
    });

    return true;
}
