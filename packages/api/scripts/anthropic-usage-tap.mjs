// Eval-only instrumentation: count the token usage of every Anthropic
// Messages API response and print a summary when the process exits, so an
// eval run can be priced from measured numbers instead of guesses.
//
// Logs token counts, model and stop_reason only — never request/response
// content, never headers (no API key). Load it before the app modules:
//   NODE_OPTIONS="--import $PWD/scripts/anthropic-usage-tap.mjs" npx tsx scripts/poc-accuracy.ts …
// The Anthropic client is created on the first call, so it captures the
// wrapped fetch.
const originalFetch = globalThis.fetch;
const byModel = new Map();
const pending = new Set();

function record(body) {
  const u = body?.usage;
  if (!u) return;
  const row = byModel.get(body.model) ?? {
    calls: 0,
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    stops: {},
  };
  row.calls += 1;
  row.input += u.input_tokens ?? 0;
  row.cacheWrite += u.cache_creation_input_tokens ?? 0;
  row.cacheRead += u.cache_read_input_tokens ?? 0;
  row.output += u.output_tokens ?? 0;
  row.stops[body.stop_reason] = (row.stops[body.stop_reason] ?? 0) + 1;
  byModel.set(body.model, row);
}

globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  try {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.startsWith("https://api.anthropic.com/") && url.includes("/v1/messages")) {
      const read = response
        .clone()
        .json()
        .then(record)
        .catch(() => {});
      pending.add(read);
      read.finally(() => pending.delete(read));
    }
  } catch {
    // instrumentation must never break the run
  }
  return response;
};

process.on("exit", () => {
  for (const [model, row] of byModel) {
    const per = (n) => (row.calls ? Math.round(n / row.calls) : 0);
    process.stderr.write(
      `[usage-tap] ${JSON.stringify({
        model,
        calls: row.calls,
        totals: {
          input: row.input,
          cacheWrite: row.cacheWrite,
          cacheRead: row.cacheRead,
          output: row.output,
        },
        perCall: {
          input: per(row.input),
          cacheWrite: per(row.cacheWrite),
          cacheRead: per(row.cacheRead),
          output: per(row.output),
        },
        stops: row.stops,
      })}\n`,
    );
  }
  if (byModel.size === 0) process.stderr.write("[usage-tap] no Anthropic calls recorded\n");
});
