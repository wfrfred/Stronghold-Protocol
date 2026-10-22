import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import * as contribution from "../../contribution/contribution.js";
import * as attribute from "../../contribution/attribute.js";
import type { Offense } from "./capability.js";

export function resolveAttack(battle: BattleState, ref: Ref<Unit & Offense>): number | undefined {
    const self = units.get(battle, ref);

    if (self === undefined) {
        return undefined;
    }

    return Math.max(
        0,
        attribute.apply(
            self.definition.offense.attack,
            contribution
                .resolve(self.offense.attack)
                .flatMap((input) => (typeof input === "function" ? input(battle, self) : input)),
        ),
    );
}
