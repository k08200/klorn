/**
 * Skill prompt template rendering — shared by the HTTP route
 * (routes/skills.ts) and the execute_skill tool (skill-executor.ts).
 */

/** Ceiling on a stored skill prompt. Defense-in-depth cap on the string a
 *  malicious `variables` key would be matched against. */
export const MAX_SKILL_PROMPT_LENGTH = 10_000;

/** Per-variable value cap. Bounds the rendered output so a template packed with
 *  placeholders paired with huge values can't amplify into a multi-MB string (a
 *  memory-DoS on the shared dyno) — the same class of risk as the ReDoS this
 *  module's split/join replaces. */
export const MAX_SKILL_VARIABLE_LENGTH = 2_000;

/**
 * Substitute `{{key}}` placeholders in a skill prompt template.
 *
 * SECURITY: `variables` keys are user-supplied. They MUST NOT be interpolated
 * into a `new RegExp(...)` — an unescaped key such as `(a+)+` turns the
 * substitution into catastrophic-backtracking ReDoS that blocks the single
 * production dyno's event loop for every user (a one-request DoS). Literal
 * `split`/`join` runs no regex engine, so a hostile key is matched
 * byte-for-byte and is inert.
 */
export function renderSkillTemplate(
  template: string,
  variables: Record<string, string> | undefined,
): string {
  if (!variables) return template;
  let out = template;
  for (const [key, value] of Object.entries(variables)) {
    // String(value) guards against a non-string slipping through the
    // (untrusted, effectively-untyped) JSON body; slice caps output amplification.
    out = out.split(`{{${key}}}`).join(String(value).slice(0, MAX_SKILL_VARIABLE_LENGTH));
  }
  return out;
}
