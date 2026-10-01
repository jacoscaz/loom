import { cast } from '@runtyped/type';

interface ICfg { a: number; b?: string }

export async function castAsyncTry(x: unknown): Promise<ICfg> {
  try {
    const r = cast<ICfg>(x);
    return r;
  } catch (err) {
    throw err;
  }
}
