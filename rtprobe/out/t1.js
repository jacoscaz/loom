const __ΩICfg = ["a", "b", "ICfg", "P'4!&4\"8Mw#y"];
castInterface.__type = ["x", () => __ΩICfg, "castInterface", "P#2!n\"/#"];
castClass.__type = ["x", () => CCfg, "castClass", "P#2!P7\"/#"];
import { cast } from '@runtyped/type';
class CCfg {
    a;
    b;
    static __type = ["a", "b", "CCfg", "'3!8&3\"85w#"];
}
export function castInterface(x) { return cast(x, void 0, void 0, void 0, [() => __ΩICfg, "n!"]); }
export function castClass(x) { return cast(x, void 0, void 0, void 0, [() => CCfg, "P7!"]); }
