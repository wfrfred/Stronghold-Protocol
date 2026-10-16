import type { Ref } from "../../../../../common/ref.js";
import type { State as BattleState } from "../../../../battle/state.js";
import type { Unit } from "../../../unit.js";
import * as units from "../../../query.js";
import type { Skill } from "../capability.js";
import type { Instance } from "../instance.js";

export function read<R>(
    battle: BattleState,
    host: Ref<Unit & Skill>,
    reader: <S extends object, A extends object>(self: Instance<S, A>, unit: Unit & Skill) => R,
): R | undefined {
    const unit = units.get(battle, host);

    return unit === undefined
        ? undefined
        : reader(
              { host, definition: unit.definition.skill, state: unit.skill } as Instance<
                  object,
                  object
              >,
              unit,
          );
}
