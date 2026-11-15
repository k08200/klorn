export type CheckStatus = "pass" | "warn" | "fail" | "skip";

/** One line of `klorn doctor`. `detail` must never contain a secret value. */
export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

export const check = (id: string, status: CheckStatus, detail: string): Check => ({
  id,
  status,
  detail,
});
