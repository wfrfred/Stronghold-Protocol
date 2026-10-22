import type { State as CooldownState } from "./cooldown.js";
import type { Definition, View as DefinitionView } from "./definition.js";

export interface View {
    readonly definition: DefinitionView;
    readonly cooldown: CooldownState;
}

export interface State<P extends object = object, E extends object = object> extends View {
    readonly definition: Definition<P, E>;
    readonly data: P;
}

export interface Snapshot extends View {
    readonly data: unknown;
}
