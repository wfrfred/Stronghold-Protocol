import { assertNonnegativeNumber } from "../../../common/assert.js";

export interface State {
    readonly periodTicks: number;
    readonly readyAtTick: number;
}

export function initialize(periodTicks: number, tick: number): State {
    assertNonnegativeNumber(periodTicks, "cooldown period");
    assertNonnegativeNumber(tick, "cooldown tick");

    return { periodTicks, readyAtTick: tick };
}

export function remaining(state: State, tick: number): number {
    assertNonnegativeNumber(tick, "cooldown tick");

    return Math.max(0, state.readyAtTick - tick);
}

export function reset(state: State, tick: number): State {
    assertNonnegativeNumber(tick, "cooldown tick");
    const readyAtTick = tick + state.periodTicks;
    assertNonnegativeNumber(readyAtTick, "cooldown deadline");

    return readyAtTick === state.readyAtTick ? state : { ...state, readyAtTick };
}

export function clear(state: State, tick: number): State {
    assertNonnegativeNumber(tick, "cooldown tick");

    return state.readyAtTick === tick ? state : { ...state, readyAtTick: tick };
}

export function resizeKeepingProgress(state: State, periodTicks: number, tick: number): State {
    assertNonnegativeNumber(periodTicks, "cooldown period");
    assertNonnegativeNumber(tick, "cooldown tick");

    if (periodTicks === state.periodTicks) {
        return state;
    }

    const fraction =
        state.periodTicks === 0 ? 0 : Math.min(1, remaining(state, tick) / state.periodTicks);
    const readyAtTick = tick + periodTicks * fraction;
    assertNonnegativeNumber(readyAtTick, "cooldown deadline");

    return { periodTicks, readyAtTick };
}

export function resizeKeepingElapsed(state: State, periodTicks: number, tick: number): State {
    assertNonnegativeNumber(periodTicks, "cooldown period");
    assertNonnegativeNumber(tick, "cooldown tick");

    if (periodTicks === state.periodTicks) {
        return state;
    }

    const elapsed = Math.max(0, tick - (state.readyAtTick - state.periodTicks));
    const readyAtTick = tick + Math.max(0, periodTicks - elapsed);
    assertNonnegativeNumber(readyAtTick, "cooldown deadline");

    return { periodTicks, readyAtTick };
}
