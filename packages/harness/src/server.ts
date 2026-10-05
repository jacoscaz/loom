#!/usr/bin/env node

import 'dotenv/config';

import pinetto, { datetimeISO, datetimeVoid } from 'pinetto';
import { ProcessWriter } from 'pinetto';

import { getDB } from "./database/client.js";
import { getConfigFromProcessArgv } from "./config/config.js";

import { PromptManager } from "./prompts/manager.js";
import { SessionManager } from "./sessions/manager.js";
import { NotificationBus } from "./notifications/bus.js";

import { Compactor } from "./sessions/compactor.js";
import { migrateToLatest } from './database/migrator.js';
import { alignEmbeddingDimensions } from './database/embedding-alignment.js';
import { Emygdala } from './emygdala/emygdala.js';
import { Recaller } from './sessions/recaller.js';
import { Distiller } from './sessions/distiller.js';
import { Embedder } from './sessions/embedder.js';
import { InitContext, type CompleteContext } from './context.js';
import { acquirePidFile, releasePidFile, defaultPidFilePath } from './pid-file.js';

import { ModelManager } from './models/manager.js';
import { FileManager } from './files/manager.js';
import { MonologueLogger } from './sessions/monologue-logger.js';

import { initJMAPTools } from "./tools/servers/jmap/init.js";
import { initTelegramTools } from './tools/servers/telegram/init.js';
import { initShellTools } from "./tools/servers/shell.js";
import { initProcessTools } from "./tools/servers/process.js";
import { initTimeTools } from "./tools/servers/time.js";
import { initSpeechTools } from "./tools/servers/speech.js";
import { initContinuityTools } from "./tools/servers/continuity.js";
import { initPinningTools } from "./tools/servers/pinning.js";
import { initContactsTools } from "./tools/servers/contacts.js";
import { initAnchorsTools } from "./tools/servers/anchors.js";
import { initSessionTools } from "./tools/servers/session.js";
import { initFilesTools } from "./tools/servers/files.js";
import { initCrontabTools } from "./tools/servers/crontab.js";
import { CrontabRunner } from './crontab/runner.js';
import { initTerminalTools } from "./tools/servers/terminal/index.js";
import { ContactsManager } from "./contacts/manager.js";
import { SpeechManager } from "./speech/manager.js";
import { RootToolManager } from './tools/manager.js';

const config = await getConfigFromProcessArgv();

// ---------------------------------------------------------------------------
// Single-instance guard (pid file). This must happen before anything else:
// two concurrent harness instances racing for the database, the notification
// bus and the continuity store is the one failure this guard must make
// impossible (2026-09-22, Jacopo, after the watchdog incident). Runs before
// the logger is set up, so its messages go to the console directly.
// ---------------------------------------------------------------------------
const pid_file_path = config.pid_file ?? defaultPidFilePath();
const pid_file_acquisition = acquirePidFile(pid_file_path);
if (!pid_file_acquisition.acquired) {
  console.error(
    `Refusing to start: another harness instance (pid ${pid_file_acquisition.conflict_pid}) ` +
    `holds the pid file at ${pid_file_acquisition.path}. Exiting.`,
  );
  process.exit(0);
}
if (pid_file_acquisition.reclaimed) {
  const { pid, reason } = pid_file_acquisition.reclaimed;
  console.warn(
    reason === 'dead-pid'
      ? `Stale pid file at ${pid_file_path} (pid ${pid} is gone) — reclaimed.`
      : `Corrupt pid file at ${pid_file_path} — reclaimed.`,
  );
}
const releasePidFileOnShutdown = () => releasePidFile(pid_file_acquisition.path);

// Main (ops) logger. Everything that is not a formatted block
// representation of the session stream goes to stderr: stdout is
// reserved for the monologue mirror (see MonologueLogger).
const logger = pinetto({
  level: config.logging.level,
  datetime: config.logging.datetime === false ? datetimeVoid : datetimeISO,
});


logger.info('PID %s', process.pid);
process.title = 'loom';

// Human-facing mirror of the session stream, one entry per block,
// written to its own rotating file. Stdout/stderr stay ops-only.
const monologue = new MonologueLogger({
  dir: config.logging.monologue_dir ?? '/var/log/loom',
});

// Shared database client
const db = getDB(config);

// Run migrations before anything else
await migrateToLatest(db, logger.child('[db:migrations]'));

// Reconcile the embedding column with the configured embedding model's
// dimensionality (retype + null-on-mismatch; see embedding-alignment.ts).
await alignEmbeddingDimensions(db, config.models.embedding.options.dimensions ?? 1536, logger.child('[db:embedding-alignment]'));

const init_context: InitContext = {
  db,
  logger,
  monologue,
  config,
  getCompleteContext: () => complete_context,
};

const complete_context: CompleteContext = {
  db,
  init: init_context,
  logger,
  monologue,
  config,
  emygdala: new Emygdala(init_context),
  compactor: new Compactor(init_context),
  distiller: new Distiller(init_context),
  embedder: new Embedder(init_context),
  buses: {
    notifications: new NotificationBus(init_context),
  },
  files: new FileManager(init_context),
  contacts: new ContactsManager(init_context),
  speech: new SpeechManager(init_context),
  recaller: new Recaller(init_context),
  crontab: new CrontabRunner(init_context),
  managers: {
    tools: new RootToolManager(init_context),
    models: new ModelManager(init_context),
    prompts: new PromptManager(init_context),
    sessions: new SessionManager(init_context),
  },
};

await complete_context.managers.models.initialize();
await complete_context.files.start();
await complete_context.managers.sessions.initialize();
await complete_context.emygdala.initialize();
await complete_context.recaller.initialize();
await complete_context.distiller.initialize(300_000);
await complete_context.embedder.initialize(60_000);
// After sessions.initialize(): the scan loop and heartbeat dispatch both
// resolve main_session_id (notification/event injection), so the crontab
// must not start scanning before the main session exists.
await complete_context.crontab.initialize();

// ============================================================================
//                          TOOL SERVER REGISTRATION
// ============================================================================
//
// All tools are harness-internal (2026-09-07, the beyond-MCP refactor):
// each init registers typed handlers on the ToolManager and receives the
// CompleteContext. Cross-tool interaction is direct function calls
// (ctx.speech, ctx.contacts, ctx.files) — the notification bus is ONLY
// the strategy for injecting asynchronous events into the weave
// (notify_NEW → session manager). No transforms, no priorities, no
// re-emits: notifiers emit COMPLETE events (standing at emission,
// transcription at emission).

initProcessTools(complete_context);

initTimeTools(complete_context);

initSpeechTools(complete_context);

initContinuityTools(complete_context);

initPinningTools(complete_context);

initContactsTools(complete_context);

initAnchorsTools(complete_context);

initSessionTools(complete_context);

initShellTools(complete_context);

initFilesTools(complete_context);

initJMAPTools(complete_context);

initTerminalTools(complete_context);

initTelegramTools(complete_context);

initCrontabTools(complete_context);

// ============================================================================
//                        MAIN SESSION INITIALIZATION
// ============================================================================

// Resolve the main session and ensure its runner is alive
const { main_session_id } = complete_context.managers.sessions;
complete_context.managers.sessions.run(main_session_id);
logger.info('main session %d is live', main_session_id);

// ============================================================================
//                          PROCESS EXIT HANDLING
// ============================================================================

const onProcessExit = (signal: 'SIGTERM' | 'SIGINT') => {
  process.removeListener('beforeExit', onProcessExit);
  process.removeListener('SIGTERM', onProcessExit);
  process.removeListener('SIGINT', onProcessExit);
  logger.warn('Received signal %s, shutting down...', signal);
  releasePidFileOnShutdown();
  db.destroy();
  setTimeout(() => process.exit(0), 1000);
};

process.on('beforeExit', onProcessExit);
process.on('SIGTERM', onProcessExit);
process.on('SIGINT', onProcessExit);
