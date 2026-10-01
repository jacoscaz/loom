import { cast } from '@runtyped/type';
interface ICfg { a: number }

// A: plain arrow, direct return
export const A = (x: unknown): ICfg => cast<ICfg>(x);
// B: async arrow, direct return
export const B = async (x: unknown): Promise<ICfg> => cast<ICfg>(x);
// C: async arrow, const inside body (no try)
export const C = async (x: unknown): Promise<ICfg> => { const r = cast<ICfg>(x); return r; };
// D: async FUNCTION, const inside body
export async function D(x: unknown): Promise<ICfg> { const r = cast<ICfg>(x); return r; }
// E: non-async arrow, const in body
export const E = (x: unknown): ICfg => { const r = cast<ICfg>(x); return r; };
