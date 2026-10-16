import type { Unit } from "../../unit.js";
import * as hook from "../../hook/hook.js";
import type { Deployable, State } from "./capability.js";

export interface Deployed {
    readonly unit: Unit & Deployable;
    readonly kind: "MANUAL" | "INITIAL" | "AUTOMATIC" | "MOVE";
}

export type DeployedHook = hook.Hook<Deployed, void>;

export function setHook(state: State, entry: DeployedHook): State {
    const deployedHooks = hook.set(state.deployedHooks, entry);

    return deployedHooks === state.deployedHooks ? state : { ...state, deployedHooks };
}

export function removeHook(state: State, id: string): State {
    const deployedHooks = hook.remove(state.deployedHooks, id);

    return deployedHooks === state.deployedHooks ? state : { ...state, deployedHooks };
}
