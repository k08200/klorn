/**
 * GOOGLE implementation of MailProviderActions — a thin delegation layer over
 * the Gmail module, which keeps client resolution (`resolveMailClient`),
 * auth-error → reconnect marking, and the local DB writes it already owns.
 */

import {
  archiveEmail,
  createEmailDraft,
  getReplyHeaders,
  markAsRead,
  sendEmail,
  toggleReadGmail,
  toggleStarGmail,
  trashEmail,
  unarchiveEmail,
  untrashEmail,
} from "../gmail.js";
import type { MailProviderActions } from "./types.js";

export const googleMailActions: MailProviderActions = {
  provider: "GOOGLE",
  sendEmail: (userId, to, subject, body, attachments = [], options) =>
    sendEmail(userId, to, subject, body, attachments, options),
  createDraft: (userId, draft) => createEmailDraft(userId, draft),
  getReplyHeaders: (userId, messageId, linkedInboxAccountId) =>
    getReplyHeaders(userId, messageId, linkedInboxAccountId),
  markAsRead: (userId, messageId, linkedInboxAccountId) =>
    markAsRead(userId, messageId, linkedInboxAccountId),
  toggleRead: (userId, messageId, isRead, linkedInboxAccountId) =>
    toggleReadGmail(userId, messageId, isRead, linkedInboxAccountId),
  toggleStar: (userId, messageId, starred, linkedInboxAccountId) =>
    toggleStarGmail(userId, messageId, starred, linkedInboxAccountId),
  trash: (userId, messageId, linkedInboxAccountId) =>
    trashEmail(userId, messageId, linkedInboxAccountId),
  untrash: (userId, messageId, linkedInboxAccountId) =>
    untrashEmail(userId, messageId, linkedInboxAccountId),
  archive: (userId, messageId, linkedInboxAccountId) =>
    archiveEmail(userId, messageId, linkedInboxAccountId),
  unarchive: (userId, messageId, linkedInboxAccountId) =>
    unarchiveEmail(userId, messageId, linkedInboxAccountId),
};
