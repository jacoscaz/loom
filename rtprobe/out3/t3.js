const __ΩICfg = ["a", "b", "ICfg", "P'4!&4\"8Mw#y"];
function __assignType(fn, args) {
    fn.__type = args;
    return fn;
}
import { cast } from '@runtyped/type';
export const castArrow = __assignType(async () => {
    try {
        const casted = cast('x');
        return casted;
    }
    catch (err) {
        if (err instanceof Error)
            throw new Error(`failed: ${err.message}`);
        throw err;
    }
}, [() => __ΩICfg, "", "Pn!`/\""]);
