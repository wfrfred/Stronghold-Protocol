import type { State as CooldownState } from "./cooldown.js";
import type { Definition } from "./definition.js";

export interface State<P extends object = object, E extends object = object> {
    readonly definition: Definition<P, E>;
    readonly data: P;
    readonly cooldown: CooldownState;
}
