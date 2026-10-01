import { cast } from '@runtyped/type';

interface ICfg { a: number; b?: string }
class CCfg { a!: number; b?: string }

export function castInterface(x: unknown): ICfg { return cast<ICfg>(x); }
export function castClass(x: unknown): CCfg { return cast<CCfg>(x); }
