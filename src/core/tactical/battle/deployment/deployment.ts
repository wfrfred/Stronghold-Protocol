import type { BattlefieldView } from "../../battlefield/contract.js";
import type { Unit } from "../../unit/unit.js";
import type { Deployable } from "../../unit/capability/deployment.js";
import * as hook from "../../unit/hook/hook.js";
import { battlefieldView, type BattleState } from "../state.js";

export interface Deployed {
    readonly unit: Unit & Deployable;
    readonly kind: "MANUAL" | "INITIAL" | "AUTOMATIC" | "MOVE";
}

export type DeployedHook = hook.Hook<BattleState, BattlefieldView, Deployed, undefined>;

export interface State {
    readonly deployedHooks: readonly DeployedHook[];
}

const initial: State = { deployedHooks: [] };

export function initialize(): State {
    return initial;
}

export function setDeployedHook(state: State, entry: DeployedHook): State {
    const deployedHooks = hook.set(state.deployedHooks, entry);

    return deployedHooks === state.deployedHooks ? state : { ...state, deployedHooks };
}

export function removeDeployedHook(state: State, id: string): State {
    const deployedHooks = hook.remove(state.deployedHooks, id);

    return deployedHooks === state.deployedHooks ? state : { ...state, deployedHooks };
}

export function notifyDeployed(state: BattleState, deployed: Deployed): BattleState {
    const candidates = state.deployment.deployedHooks.map(({ id }) => id);

    for (const id of candidates) {
        const entry = state.deployment.deployedHooks.find((current) => current.id === id);

        if (entry !== undefined) {
            const view = battlefieldView(state);

            if (entry.enabled(view)) {
                state = entry.invoke(state, view, deployed).state;
            }
        }
    }

    return state;
}
