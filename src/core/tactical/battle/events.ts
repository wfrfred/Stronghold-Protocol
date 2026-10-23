import type { Event, UnitRemoval } from "./contract.js";
import { copy } from "../unit/snapshot.js";

export function finishBattleEvents(
    phaseEvents: readonly Event[],
    removedUnits: readonly UnitRemoval[],
    tick: number,
) {
    const events: Event[] = [
        ...phaseEvents,
        ...removedUnits.map((removed): Event => ({
            type: "UNIT_REMOVED",
            ...removed,
            unit: copy(removed.unit),
            tick,
        })),
    ];

    return {
        events,
        completedRouteCount: events.filter((event) => event.type === "ROUTE_COMPLETED").length,
    };
}
