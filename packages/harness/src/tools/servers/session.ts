// Session tools — ported from the MCP server (2026-09-07 overnight
// handoff). compact / switch_substrate / info operate on the CALLING
// session (origin_session_id), semantics unchanged.

import { type CompleteContext } from "../../context.js";
import { REASONING_EFFORTS } from "../../constants.js";
import { type TextBlock } from "../../types/blocks.js";

const text = (s: string): TextBlock[] => [{ type: 'text', text: s }];

export const initSessionTools = (ctx: CompleteContext) => {

  ctx.managers.tools.add<{ retain_count?: number; drop_media?: boolean }>(
    'session_compact',
    'Compact',
    'Compact the session by summarizing older messages and retaining recent ones. Uses a dedicated compactor model. With drop_media, media blocks (images, voice notes) in the retained tail are replaced by labelled text markers — captions and transcriptions survive as text, binary payloads do not.',
    true,
    async ({ retain_count, drop_media }, call_ctx) => {
      await ctx.compactor.compact(call_ctx.origin_session_id, retain_count ?? 20, { drop_media }, call_ctx.db);
      return text('Compaction successful.');
    },
  );

  ctx.managers.tools.add<{
    /** Config id of the target session model (e.g. 'z-ai/glm-5.3-flash'). Omit to keep the current model. */
    model?: string;
    /** Requested reasoning effort. Omit to keep the current effort. */
    reasoning_effort?: string;
  }>(
    'session_switch_substrate',
    'Switch Substrate',
    'Switch this session\'s substrate at runtime: select a different session model (by its config id, e.g. \'z-ai/glm-5.3-flash\' — the first configured model is the one sessions start on) and/or request a different reasoning effort (none/minimal/low/medium/high/xhigh). Both parameters are optional; provide at least one. Reasoning-effort requests are no-ops (never errors) on models that do not support them. Model switches are session-scoped and reset to the first configured model on harness restart.',
    true,
    async ({ model, reasoning_effort }, call_ctx) => {
      const session_id = call_ctx.origin_session_id;
      if (model === undefined && reasoning_effort === undefined) {
        return text(`Error: provide model (id — one of: ${ctx.managers.models.sessionModels.map(m => m.id).join(', ')}), reasoning_effort, or both.`);
      }
      const results: string[] = [];
      if (model !== undefined) {
        try {
          const active_id = ctx.managers.sessions.switchSessionModel(session_id, model);
          results.push(`model switched to: ${active_id}`);
        } catch (err) {
          return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (reasoning_effort !== undefined) {
        if (!(REASONING_EFFORTS as readonly string[]).includes(reasoning_effort)) {
          return text(`Error: invalid reasoning_effort '${reasoning_effort}'. Valid values: ${REASONING_EFFORTS.join(', ')}.`);
        }
        const applied = ctx.managers.sessions.setSessionReasoningEffort(session_id, reasoning_effort);
        results.push(applied
          ? `reasoning effort set to: ${reasoning_effort}`
          : `reasoning effort '${reasoning_effort}' not supported by the active model — request ignored (no error)`);
      }
      return text(results.join('\n'));
    },
  );

  ctx.managers.tools.add<Record<string, never>>(
    'session_info',
    'Session Info',
    'Returns information about the current session: token count (prompt_size), context window size, pressure ratio, and message count.',
    true,
    async (_params, call_ctx) => {
      const session_id = call_ctx.origin_session_id;
      const session = await call_ctx.db
        .selectFrom('sessions')
        .where('id', '=', session_id)
        .select(['prompt_size', 'input_tokens_count', 'output_tokens_count'])
        .executeTakeFirstOrThrow();

      // The session's ACTUAL active model (may have switched mid-session).
      const max_context_size = ctx.managers.sessions
        .getSessionModel(session_id).max_context_size;
      const pressure = session.prompt_size / max_context_size;

      const message_count = await call_ctx.db
        .selectFrom('messages')
        .where('session_id', '=', session_id)
        .select(qb => qb.fn.countAll().as('count'))
        .executeTakeFirstOrThrow();

      const info = {
        prompt_size: session.prompt_size,
        max_context_size,
        pressure: Math.round(pressure * 100) / 100,
        pressure_percent: Math.round(pressure * 100),
        input_tokens_count: session.input_tokens_count,
        output_tokens_count: session.output_tokens_count,
        message_count: Number(message_count.count),
      };

      return text(JSON.stringify(info, null, 2));
    },
  );

};
