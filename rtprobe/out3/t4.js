const __ΩICfg = ["a", "ICfg", "P'4!Mw\"y"];
function __assignType(fn, args) {
    fn.__type = args;
    return fn;
}
D.__type = ["x", () => __ΩICfg, "D", "P#2!n\"`/#"];
import { cast } from '@runtyped/type';
// A: plain arrow, direct return
export const A = __assignType((x) => cast(x), ["x", () => __ΩICfg, "", "P#2!n\"/#"]);
// B: async arrow, direct return
export const B = __assignType(async (x) => cast(x), ["x", () => __ΩICfg, "", "P#2!n\"`/#"]);
// C: async arrow, const inside body (no try)
export const C = __assignType(async (x) => { const r = cast(x); return r; }, ["x", () => __ΩICfg, "", "P#2!n\"`/#"]);
// D: async FUNCTION, const inside body
export async function D(x) { const r = cast(x, void 0, void 0, void 0, [() => __ΩICfg, "n!"]); return r; }
// E: non-async arrow, const in body
export const E = __assignType((x) => { const r = cast(x); return r; }, ["x", () => __ΩICfg, "", "P#2!n\"/#"]);
