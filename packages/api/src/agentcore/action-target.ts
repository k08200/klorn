/**
 * Resolve a human-readable label for a pending action's target.
 *
 * When a pending action is a delete/update operation, the raw tool args only
 * carry an ID — useless to the user. This helper looks the entity up and
 * returns its title/name so UIs can render the actual target.
 *
 * Returns null when no resolver is registered for the tool or the entity
 * lookup fails. Add branches here as new pending-action-eligible tools land.
 */

export async function resolveActionTarget(
  _toolName: string,
  _args: Record<string, unknown>,
): Promise<string | null> {
  return null;
}
