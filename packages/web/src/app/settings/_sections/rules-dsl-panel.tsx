"use client";

// Settings → Lanes: "Rules as text" (Rules DSL v1). Shown only while the
// API's RULES_DSL_ENABLED opens it to this user (/me user.rulesDsl). The
// server parses, previews and applies; this panel only edits text and shows
// what the server said. Apply always asks first.

import type {
  RulesDslApplyResponse,
  RulesDslDryRunResponse,
  RulesDslErrorWire,
  RulesDslExportResponse,
  RulesDslValidateResponse,
} from "@klorn/contract";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useConfirm } from "../../../components/confirm-dialog";
import { LaneChip } from "../../../components/lane-chip";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import { API_BASE, authHeaders } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import {
  dslErrorsFrom,
  dslFailureKey,
  offsetOfPosition,
  RULES_DSL_PATHS,
  rulesDslVisible,
} from "./rules-dsl";
import { PANEL } from "./shared";

type Busy = "load" | "validate" | "dryRun" | "apply" | null;
type Reply<T> = { ok: true; data: T } | { ok: false; status: number; body: unknown };

const EDITOR =
  "w-full min-h-80 rounded-control border border-line bg-surface-raised px-3 py-2 font-mono text-role-caption leading-5 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 aria-invalid:border-state-danger-line";

async function send<T>(path: string, body?: unknown): Promise<Reply<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: authHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => null);
  return res.ok ? { ok: true, data: json as T } : { ok: false, status: res.status, body: json };
}

export function RulesDslPanel({ onApplied }: { onApplied?: () => void }) {
  const { user } = useAuth();
  const { t } = useT();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const editorId = useId();
  const errorsId = useId();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState<RulesDslErrorWire[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<RulesDslDryRunResponse | null>(null);
  const [applicable, setApplicable] = useState(true);
  const visible = rulesDslVisible(user);
  // Latest t/toast without making load() depend on them: a language switch
  // must not reload the text over unsaved edits.
  const tRef = useRef(t);
  tRef.current = t;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const fail = useCallback((reply: { status: number; body: unknown }) => {
    const found = dslErrorsFrom(reply.body);
    setErrors(found);
    setTruncated(Boolean((reply.body as { truncated?: unknown } | null)?.truncated));
    if (found.length === 0) {
      toastRef.current(tRef.current(dslFailureKey(reply.status, reply.body)), "error");
    }
  }, []);

  const run = useCallback(
    async <T,>(kind: Exclude<Busy, null>, path: string, body?: unknown) => {
      setBusy(kind);
      setStatus("");
      try {
        const reply = await send<T>(path, body);
        if (!reply.ok) fail(reply);
        return reply;
      } catch (err) {
        captureClientError(err, { scope: `settings.rules-dsl.${kind}` });
        toastRef.current(tRef.current("rulesDsl.error.failed"), "error");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [fail],
  );

  const load = useCallback(async () => {
    const reply = await run<RulesDslExportResponse>("load", RULES_DSL_PATHS.export);
    if (!reply?.ok) return;
    setText(reply.data.text);
    setBaseHash(reply.data.baseHash);
    setApplicable(reply.data.applicable);
    setErrors([]);
    setTruncated(false);
    setPreview(null);
  }, [run]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  if (!visible) return null;

  // Anything shown for the previous text (errors and their positions, the
  // preview, "no problems") no longer describes what is in the editor.
  const edit = (value: string) => {
    setText(value);
    setErrors([]);
    setTruncated(false);
    setPreview(null);
    setStatus("");
  };

  const goTo = (error: RulesDslErrorWire) => {
    const editor = editorRef.current;
    if (!editor) return;
    const offset = offsetOfPosition(text, error.line, error.column);
    editor.focus();
    editor.setSelectionRange(offset, offset);
  };

  const validate = async () => {
    const reply = await run<RulesDslValidateResponse>("validate", RULES_DSL_PATHS.validate, {
      text,
    });
    if (!reply?.ok) return;
    setErrors(reply.data.errors);
    setTruncated(reply.data.truncated);
    if (reply.data.ok) setStatus(t("rulesDsl.valid", { n: String(reply.data.ruleCount) }));
  };

  const dryRun = async () => {
    const reply = await run<RulesDslDryRunResponse>("dryRun", RULES_DSL_PATHS.dryRun, { text });
    if (!reply?.ok) return;
    setErrors([]);
    setPreview(reply.data);
  };

  const apply = async () => {
    if (!baseHash) return;
    const ok = await confirm({
      title: t("rulesDsl.confirm.title"),
      message: t("rulesDsl.confirm.message"),
      confirmLabel: t("rulesDsl.confirm.label"),
    });
    if (!ok) return;
    const reply = await run<RulesDslApplyResponse>("apply", RULES_DSL_PATHS.apply, {
      text,
      baseHash,
    });
    if (!reply?.ok) return;
    const { added, changed, removed } = reply.data;
    setText(reply.data.text);
    setBaseHash(reply.data.baseHash);
    setApplicable(reply.data.applicable);
    setErrors([]);
    setTruncated(false);
    setPreview(null);
    toast(
      t("rulesDsl.applied", {
        added: String(added),
        changed: String(changed),
        removed: String(removed),
      }),
      "success",
    );
    onApplied?.();
  };

  return (
    <div className={`${PANEL} mt-4 p-4 space-y-3`}>
      <div>
        <h3 className="font-medium">{t("rulesDsl.title")}</h3>
        <p className="text-role-body text-ink-mid">{t("rulesDsl.desc")}</p>
      </div>
      <label htmlFor={editorId} className="block text-role-body font-medium text-ink">
        {t("rulesDsl.editorLabel")}
      </label>
      <textarea
        id={editorId}
        ref={editorRef}
        value={text}
        onChange={(e) => edit(e.target.value)}
        // Read-only while a request runs, so an answer always matches the text.
        readOnly={busy !== null}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        rows={16}
        aria-invalid={errors.length > 0}
        aria-describedby={errors.length > 0 ? errorsId : undefined}
        className={EDITOR}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="lg"
          onClick={validate}
          loading={busy === "validate"}
          disabled={busy !== null}
        >
          {t("rulesDsl.validate")}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          onClick={dryRun}
          loading={busy === "dryRun"}
          disabled={busy !== null}
        >
          {t("rulesDsl.dryRun")}
        </Button>
        <Button
          variant="primary"
          size="lg"
          onClick={apply}
          loading={busy === "apply"}
          disabled={busy !== null || !baseHash || !applicable}
        >
          {t("rulesDsl.apply")}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          onClick={load}
          loading={busy === "load"}
          disabled={busy !== null}
        >
          {t("rulesDsl.reload")}
        </Button>
      </div>
      {!applicable && (
        <p className="text-role-body text-state-danger-ink">{t("rulesDsl.notApplicable")}</p>
      )}
      <p role="status" aria-live="polite" className="text-role-body text-ink-mid">
        {busy === "load" ? t("rulesDsl.loading") : status}
      </p>
      {errors.length > 0 && (
        <ErrorList id={errorsId} errors={errors} truncated={truncated} onPick={goTo} />
      )}
      {preview && <Preview preview={preview} />}
    </div>
  );
}

function ErrorList({
  id,
  errors,
  truncated,
  onPick,
}: {
  id: string;
  errors: RulesDslErrorWire[];
  truncated: boolean;
  onPick: (error: RulesDslErrorWire) => void;
}) {
  const { t } = useT();
  return (
    <div id={id} role="alert" className="space-y-1">
      <p className="text-role-body font-medium text-state-danger-ink">
        {t("rulesDsl.errorsTitle", { n: String(errors.length) })}
      </p>
      <ul className="space-y-1">
        {errors.map((error) => (
          <li key={`${error.line}:${error.column}:${error.code}`}>
            <Button variant="ghost" size="lg" onClick={() => onPick(error)} className="w-full">
              <span className="block w-full text-left">
                <span className="font-mono text-ink-mid">
                  {t("rulesDsl.errorAt", {
                    line: String(error.line),
                    column: String(error.column),
                  })}
                </span>{" "}
                {error.message}
              </span>
            </Button>
          </li>
        ))}
      </ul>
      {truncated && (
        <p className="text-role-caption text-ink-mid">{t("rulesDsl.errorsTruncated")}</p>
      )}
    </div>
  );
}

function Preview({ preview }: { preview: RulesDslDryRunResponse }) {
  const { t } = useT();
  const titleId = useId();
  const counts = { examined: String(preview.examined), changed: String(preview.changed) };
  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-control border border-line p-3">
      <h4 id={titleId} className="font-medium">
        {t("rulesDsl.preview.title")}
      </h4>
      <p className="text-role-body text-ink">
        {preview.changed === 0
          ? t("rulesDsl.preview.none", counts)
          : t("rulesDsl.preview.summary", counts)}
      </p>
      {preview.manualKept > 0 && (
        <p className="text-role-caption text-ink-mid">
          {t("rulesDsl.preview.manualKept", { n: String(preview.manualKept) })}
        </p>
      )}
      {preview.transitions.length > 0 && (
        <ul className="space-y-1">
          {preview.transitions.map((row) => (
            <li
              key={`${row.from}>${row.to ?? ""}`}
              className="flex flex-wrap items-center gap-2 text-role-body"
            >
              <LaneChip tier={row.from} />
              <span aria-hidden="true">→</span>
              {row.to ? <LaneChip tier={row.to} /> : <span>{t("rulesDsl.preview.toJudge")}</span>}
              <span className="text-ink-mid">
                {t("rulesDsl.preview.count", { n: String(row.count) })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {preview.samples.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-role-body">
            {t("rulesDsl.preview.examples")}
          </summary>
          <ul className="space-y-1">
            {preview.samples.map((sample) => (
              <li key={sample.id} className="text-role-caption text-ink-mid">
                <span className="text-ink">{sample.sender}</span> — {sample.subject}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-role-caption text-ink-mid">{t("rulesDsl.preview.note")}</p>
    </section>
  );
}
