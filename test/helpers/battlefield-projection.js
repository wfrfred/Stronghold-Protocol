import { ref } from "../../dist/core/tactical/unit/query.js";

function occupancyFor(map, units) {
    const occupancy = new Map();
    for (const unit of units.values()) {
        const registration = unit.occupancy?.registration;
        if (registration == null) continue;
        const [row, column] = registration.tile;
        if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) ||
            row < 0 || row >= map.rows || column < 0 || column >= map.columns) {
            throw new RangeError("occupancy registration is outside the battlefield");
        }
        const key = row * map.columns + column;
        const entry = occupancy.get(key) ?? { occupant: null, support: null };
        const slot = registration.slot === "OCCUPANT" ? "occupant" : "support";
        if (entry[slot] !== null && entry[slot].id !== unit.id) {
            throw new RangeError("occupancy slot is already occupied");
        }
        occupancy.set(key, { ...entry, [slot]: ref(unit) });
    }
    return occupancy;
}

export function maintainFully(previous, content) {
    return {
        ...previous,
        ...content,
        occupancy: occupancyFor(previous.map, content.units),
    };
}
