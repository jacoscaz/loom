
import { type Logger } from "pinetto";
import { type MonologueLogger } from "./sessions/monologue-logger.js";
import { type Emygdala } from "./emygdala/emygdala.js";
import { type PromptManager } from "./prompts/manager.js";
import { type SessionManager } from "./sessions/manager.js";
import { type Compactor } from "./sessions/compactor.js";
import { type NotificationBus } from "./notifications/bus.js";
import { type Distiller } from "./sessions/distiller.js";
import { type Embedder } from "./sessions/embedder.js";
import { type Recaller } from "./sessions/recaller.js";
import { type CrontabRunner } from "./crontab/runner.js";
import { type ContactsManager } from "./contacts/manager.js";
import { type SpeechManager } from "./speech/manager.js";
import { type DB } from "./database/client.js";
import { type Config } from "./config/config.js";
import { type ModelManager } from "./models/manager.js";
import { type FileManager } from "./files/manager.js";
import { type RootToolManager } from "./tools/manager.js";

import EventEmitter from "node:events";




/*
 * The context of the agent contains instances of all interfaces and classes
 * comprising this harness. However, because this context both contains these
 * instances and must also be passed to them, we need some way to work around
 * use-before-instantiation errors.
 *
 * The solution is to split the context in two: `InitContext`, which is the
 * minimal subset required for component instantiation, and `CompleteContext`,
 * which can be retrieved after instantiation as per the `WithContext` class.
 */

 /**
  * Context used to initialize the different components of this harness. This
  * is only meant to be passed to constructors at instantiation time.
  */
export interface InitContext {
  db: DB;
  config: Config;
  logger: Logger;
  /** Human-facing mirror of the session stream to stdout (Phase I). */
  monologue: MonologueLogger;
  getCompleteContext: () => CompleteContext;
}

/**
 * Context used to lookup instances of all the components making up the harness.
 */
export interface CompleteContext {
  db: DB;
  init: InitContext;
  config: Config;
  logger: Logger;
  monologue: MonologueLogger;
  emygdala: Emygdala;
  compactor: Compactor;
  distiller: Distiller;
  embedder: Embedder;
  buses: {
    notifications: NotificationBus;
  };
  files: FileManager;
  contacts: ContactsManager;
  speech: SpeechManager;
  recaller: Recaller;
  crontab: CrontabRunner;
  managers: {
    tools: RootToolManager;
    models: ModelManager;
    prompts: PromptManager;
    sessions: SessionManager;
  };
}

/**
 * Helper class that centralizes the indirect context lookup that prevents
 * use-before-instantiation errors. Instances are created with `InitContext`
 * while being able to acquire `CompleteContext` via the `this._ctx` getter.
 */
export class WithContext<E extends Record<string, any[]> = {}> extends EventEmitter<E> {
  readonly #getCompleteContext: () => CompleteContext;
  constructor(init: InitContext) {
    super();
    this.#getCompleteContext = init.getCompleteContext;
  }
  protected get _ctx(): CompleteContext {
    return this.#getCompleteContext();
  }
}
