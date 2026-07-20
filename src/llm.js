import { config } from './config.js';

/**
 * One OpenAI-compatible chat call (Xona inference), JSON-mode.
 * Returns { json, raw, latencyMs }. Throws on transport errors or if no JSON.
 */
export async function decide(model, systemPrompt, userPrompt) {
  if (!config.inference.apiKey) {
    throw new Error('INFERENCE_API_KEY is not set');
  }
  const started = Date.now();
  const res = await fetch(`${config.inference.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.inference.apiKey}`,
      'X-Title': 'Xona World Arena',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      // Reasoning models (kimi-k3 et al.) burn thinking tokens from this same
      // budget before emitting content — keep it roomy or content comes back empty.
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }),
    // Reasoning models can think for minutes; keep under the cycle interval.
    signal: AbortSignal.timeout(150_000),
  });
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status} for ${model}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const choice = data?.choices?.[0];
  const raw = choice?.message?.content || '';
  const json = extractJson(raw);
  if (!json) {
    throw new Error(`No JSON in ${model} response (finish=${choice?.finish_reason}): ${raw.slice(0, 200)}`);
  }
  return { json, raw, latencyMs };
}

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) {
    try { return JSON.parse(brace[0]); } catch {}
  }
  return null;
}
