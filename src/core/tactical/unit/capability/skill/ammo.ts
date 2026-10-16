import { assertPositiveSafeInteger } from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import * as units from "../../query.js";
import { ref as activationRef, type Activation } from "./activation.js";
import { dispatch } from "./hook.js";
import { finish } from "./operations.js";
import * as query from "./query.js";
import type { Ammo } from "./sustain.js";

export interface Consumed {
    readonly ref: Ref<Activation>;
    readonly amount: number;
    readonly previous: Ammo;
    readonly current: Ammo;
}

export interface Replenished {
    readonly ref: Ref<Activation>;
    readonly requested: number;
    readonly amount: number;
    readonly previous: Ammo;
    readonly current: Ammo;
}

export type Outcome =
    | { readonly type: "APPLIED"; readonly amount: number; readonly remaining: number }
    | { readonly type: "REJECTED"; readonly reason: "UNAVAILABLE" | "NO_AMMO" };

export function consume(
    battle: BattleState,
    reference: Ref<Activation>,
    amount = 1,
): Result<Outcome> {
    assertPositiveSafeInteger(amount, "skill ammunition consumption");

    const self = units.get(battle, reference.host);

    if (self === undefined) {
        return rejected(battle, "UNAVAILABLE");
    }

    const active = self.skill.active;

    if (self.lifecycle !== "PRESENT" || active?.id !== reference.id || active.status !== "ACTIVE") {
        return rejected(battle, "UNAVAILABLE");
    }
    if (active.sustain.type !== "AMMO") {
        return rejected(battle, "NO_AMMO");
    }

    const previous = active.sustain;
    const current = { ...previous, remaining: previous.remaining - amount };

    if (!Number.isSafeInteger(current.remaining)) {
        throw new RangeError("skill ammunition overflow");
    }

    battle = query.replace(battle, {
        ...self,
        skill: { ...self.skill, active: { ...active, sustain: current } },
    });
    battle = dispatch(battle, units.ref(self), "ammoConsumed", {
        ref: activationRef(active),
        amount,
        previous,
        current,
    });

    return {
        state: battle,
        value: { type: "APPLIED", amount, remaining: current.remaining },
    };
}

export function replenish(
    battle: BattleState,
    reference: Ref<Activation>,
    amount = 1,
): Result<Outcome> {
    return add(battle, reference, amount, true);
}

export function grant(
    battle: BattleState,
    reference: Ref<Activation>,
    amount = 1,
): Result<Outcome> {
    return add(battle, reference, amount, false);
}

export function check(battle: BattleState, reference: Ref<Activation>): BattleState {
    const active = query.get(battle, reference);

    return active?.status === "ACTIVE" &&
        active.sustain.type === "AMMO" &&
        active.sustain.remaining <= 0
        ? finish(battle, reference)
        : battle;
}

function add(
    battle: BattleState,
    reference: Ref<Activation>,
    requested: number,
    replenishing: boolean,
): Result<Outcome> {
    assertPositiveSafeInteger(requested, "skill ammunition replenishment");

    const self = units.get(battle, reference.host);

    if (self === undefined) {
        return rejected(battle, "UNAVAILABLE");
    }

    const active = self.skill.active;

    if (self.lifecycle !== "PRESENT" || active?.id !== reference.id || active.status !== "ACTIVE") {
        return rejected(battle, "UNAVAILABLE");
    }
    if (active.sustain.type !== "AMMO") {
        return rejected(battle, "NO_AMMO");
    }

    const previous = active.sustain;
    const amount = Math.max(
        0,
        Math.min(
            requested,
            previous.initial - previous.remaining,
            replenishing ? previous.initial - previous.replenished : requested,
        ),
    );

    if (amount === 0) {
        return {
            state: battle,
            value: { type: "APPLIED", amount, remaining: previous.remaining },
        };
    }

    const current = {
        ...previous,
        remaining: previous.remaining + amount,
        replenished: previous.replenished + (replenishing ? amount : 0),
    };
    battle = query.replace(battle, {
        ...self,
        skill: { ...self.skill, active: { ...active, sustain: current } },
    });

    if (replenishing) {
        battle = dispatch(battle, units.ref(self), "ammoReplenished", {
            ref: activationRef(active),
            requested,
            amount,
            previous,
            current,
        });
    }

    return {
        state: battle,
        value: { type: "APPLIED", amount, remaining: current.remaining },
    };
}

function rejected(state: BattleState, reason: "UNAVAILABLE" | "NO_AMMO"): Result<Outcome> {
    return { state, value: { type: "REJECTED", reason } };
}
