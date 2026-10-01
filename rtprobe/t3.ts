import { cast } from '@runtyped/type';

interface ICfg { a: number; b?: string }

export const castArrow = async (): Promise<ICfg> => {
  try {
    const casted = cast<ICfg>('x' as unknown as never);
    return casted;
  } catch (err) {
    if (err instanceof Error) throw new Error(`failed: ${err.message}`);
    throw err;
  }
};
