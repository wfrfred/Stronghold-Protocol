import { assertPositiveSafeInteger } from "../../../core/common/assert.js";
import type { Ref } from "../../../core/common/ref.js";
import type { State as BattleState } from "../../../core/tactical/battle/state.js";
import { setNavigation } from "../../../core/tactical/battlefield/state.js";
import type { Overlay } from "../../../core/tactical/battlefield/navigation/overlay.js";
import * as navigation from "../../../core/tactical/battlefield/navigation/state.js";
import { World, type TilePosition } from "../../../core/tactical/geometry/coordinate.js";
import { isSpatiallyPresent } from "../../../core/tactical/unit/capability/presence/capability.js";
import type { Definition } from "../../../core/tactical/unit/effect/definition.js";
import { ref, type Effect } from "../../../core/tactical/unit/effect/effect.js";
import { update } from "../../../core/tactical/unit/effect/operations.js";
import * as units from "../../../core/tactical/unit/query.js";

interface State {
    readonly overlay: Ref<Overlay> | null;
    readonly position: TilePosition | null;
}

function remove(battle: BattleState, self: Effect<State>): BattleState {
    if (self.data.overlay === null || self.data.position === null) {
        return battle;
    }

    const next = navigation.removeOverlay(battle.battlefield.navigation, "WALK", self.data.overlay);
    battle = { ...battle, battlefield: setNavigation(battle.battlefield, next) };

    return update(battle, ref(self), (data) => ({ ...data, position: null }));
}

export function create(id: string, cost: number): Definition<State> {
    assertPositiveSafeInteger(cost, "tile navigation cost");

    const synchronize = (battle: BattleState, self: Effect<State>): BattleState => {
        const unit = units.get(battle, self.host);

        if (unit === undefined || !isSpatiallyPresent(unit)) {
            return remove(battle, self);
        }

        const position = World.toTile(unit.position);

        if (
            self.data.position !== null &&
            self.data.position[0] === position[0] &&
            self.data.position[1] === position[1]
        ) {
            return battle;
        }

        let overlay = self.data.overlay;

        if (overlay === null) {
            const nextOverlayId = battle.execution.nextOverlayId + 1;

            if (!Number.isSafeInteger(nextOverlayId)) {
                throw new RangeError("navigation overlay identity overflow");
            }

            overlay = { id: battle.execution.nextOverlayId } as Ref<Overlay>;
            battle = { ...battle, execution: { ...battle.execution, nextOverlayId } };
        }

        const next = navigation.setOverlay(battle.battlefield.navigation, "WALK", {
            id: overlay.id,
            cells: [position],
            denyPassage: false,
            denyDepartures: [],
            cost,
        });
        battle = { ...battle, battlefield: setNavigation(battle.battlefield, next) };

        return update(battle, ref(self), (data) => ({ ...data, overlay, position }));
    };

    return {
        id,
        initialize: () => ({ overlay: null, position: null }),
        onEnable: synchronize,
        onTick: synchronize,
        onDisable: remove,
    };
}
