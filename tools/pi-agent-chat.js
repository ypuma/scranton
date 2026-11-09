export const CHAT_TITLE = 'scranton.agent_chat.v1';
// Leave transport headroom between recipient, broker and Pi's local UI deadline.
export const RPC_ACK_TIMEOUT_MS = 5000;
export const CHAT_ACK_TIMEOUT_MS = 10000;
export const CHAT_TIMEOUT_MS = 15000;

export function validChat(value) {
  return value && Object.keys(value).every((k) => k === 'to' || k === 'text') &&
    typeof value.to === 'string' && value.to.length > 0 && value.to.length <= 200 &&
    typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 16000;
}

export default function agentChat(pi) {
  pi.registerTool({
    name: 'agent_chat',
    label: 'Agent chat',
    description: 'Send text to an exact agent instance ID. ACK means queue acceptance, not model consumption. Sender and run are assigned by the host. If delivery is unknown, do not resend automatically: the message may already be queued.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['to', 'text'],
      properties: { to: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', minLength: 1, maxLength: 16000 } }
    },
    async execute(_id, params, signal, _update, ctx) {
      let ack;
      if (!validChat(params) || signal?.aborted || ctx.mode !== 'rpc') {
        ack = { ok: false, error: 'Chat unavailable or invalid request' };
      } else {
        try {
          const raw = await ctx.ui.input(CHAT_TITLE, JSON.stringify({ to: params.to, text: params.text }), { signal, timeout: CHAT_TIMEOUT_MS });
          ack = raw === undefined ? { ok: false, delivery: 'unknown', error: 'Chat cancelled or ACK timed out; delivery unknown. Do not resend automatically.' } : JSON.parse(raw);
          if (typeof ack?.ok !== 'boolean') ack = { ok: false, delivery: 'unknown', error: 'Invalid host ACK; delivery unknown. Do not resend automatically.' };
        } catch (error) {
          ack = { ok: false, delivery: 'unknown', error: `${error.message}; delivery unknown. Do not resend automatically.` };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(ack) }], details: ack, isError: !ack.ok };
    }
  });
}
