import { assertPositiveSafeInteger } from "../../../core/common/assert.js";
import type { Ref } from "../../../core/common/ref.js";

import { ref as actionRef } from "../../../core/tactical/unit/action/action.js";
import { get as getAction } from "../../../core/tactical/unit/action/operations.js";
import { ref, type Activation } from "../../../core/tactical/unit/capability/skill/activation.js";
import { consume, check } from "../../../core/tactical/unit/capability/skill/ammo.js";
import { hasSkill } from "../../../core/tactical/unit/capability/skill/capability.js";
import * as units from "../../../core/tactical/unit/query.js";
import { createWithState, type Attack, type Definition as AttackDefinition } from "./attack.js";

export interface State {
    readonly activation: Ref<Activation> | null;
}

export interface Definition extends AttackDefinition<object, State> {
    readonly ammoPerAction?: number;
}

export function create(definition: Definition): Attack<object, State> {
    const amount = definition.ammoPerAction ?? 1;
    const afterOutput = definition.afterOutput;
    assertPositiveSafeInteger(amount, "skill attack ammunition consumption");

    return createWithState<object, State>({
        ...definition,
        initialize: (battle) => ({ state: battle, value: {} }),
        start(battle, source) {
            const host = units.get(battle, source);

            return {
                state: battle,
                value: {
                    activation:
                        host !== undefined && hasSkill(host) && host.skill.active !== null
                            ? ref(host.skill.active)
                            : null,
                },
            };
        },
        afterOutput(battle, self) {
            battle = afterOutput?.(battle, self) ?? battle;
            const current = getAction(battle, actionRef(self));
            const activation = current?.state.data.activation;

            if (current?.status !== "RUNNING" || activation == null) {
                return battle;
            }

            battle = consume(battle, activation, amount).state;

            return check(battle, activation);
        },
    });
}
