/**
 * A refusal from the organization service, with the HTTP status and the
 * stable code clients branch on. routes/orgs.ts turns it into
 * `{ error, code }`; anything else falls through to the global handler.
 */

export type OrgErrorCode =
  | "INVALID_BODY"
  | "INVALID_NAME"
  | "INVALID_EMAIL"
  | "INVALID_DOMAINS"
  | "INVALID_CAP"
  | "OWNER_ONLY"
  | "INVITE_EMAIL_MISMATCH"
  | "NOT_IN_ORG"
  | "NOT_A_MEMBER"
  | "MEMBER_NOT_FOUND"
  | "INVITE_NOT_FOUND"
  | "INVITE_INVALID"
  | "ALREADY_IN_ORG"
  | "ALREADY_MEMBER"
  | "MEMBER_LIMIT"
  | "OWNER_MUST_TRANSFER"
  | "CANNOT_REMOVE_OWNER"
  | "SUBSCRIPTION_ACTIVE"
  | "INVITE_EXPIRED"
  | "INVITE_USED"
  | "INVITE_EMAIL_FAILED"
  | "INVITE_LIMIT"
  | "EMAIL_NOT_VERIFIED";

export class OrgError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: OrgErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrgError";
  }
}

export function isOrgError(err: unknown): err is OrgError {
  return err instanceof OrgError;
}
