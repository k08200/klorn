/**
 * Rules DSL v1 parser: text → AST, or every error with its line:column
 * (grammar in docs/design/rules-dsl.md §3). Line-oriented; each statement
 * is matched against a fixed token shape. Pure.
 */

import { type Expect, problems } from "./errors.js";
import { RULES_DSL_LIMITS } from "./limits.js";
import { findForbidden, utf8ByteLength } from "./text.js";
import { type Token, tokenizeLine } from "./tokenize.js";
import {
  type AstRule,
  type AstThen,
  type AstWhen,
  DSL_LANES,
  type DslError,
  type DslFailure,
  type DslLane,
  type DslProblem,
  type ParseResult,
} from "./types.js";

const RETIRED_LANES = new Set(["AUTO", "CALL"]);
const BOM = 0xfeff;
const CLAUSES: ReadonlySet<string> = new Set(["when", "then", "note", "disabled"]);

interface RuleBuilder {
  name: string;
  line: number;
  column: number;
  note: string | null;
  disabled: boolean | null;
  sender: AstWhen | null;
  senderCount: number;
  target: AstThen | null;
  /** Any error inside the block: then a missing clause is not reported too. */
  broken: boolean;
}

class Parser {
  readonly errors: DslError[] = [];
  readonly rules: AstRule[] = [];
  private current: RuleBuilder | null = null;
  private sawStatement = false;
  private ruleCount = 0;
  stopped = false;

  constructor(private lineNo = 0) {}

  setLine(lineNo: number): void {
    this.lineNo = lineNo;
  }

  fail(column: number, problem: DslProblem): void {
    this.errors.push({ line: this.lineNo, column, ...problem });
    if (this.current) this.current.broken = true;
  }

  statement(tokens: Token[], lineLength: number): void {
    const head = tokens[0] as Token;
    const keyword = head.kind === "word" ? head.text : "";
    if (!this.sawStatement) {
      this.sawStatement = true;
      if (keyword === "version") {
        this.version(tokens, lineLength);
        return;
      }
      this.fail(head.column, problems.missingVersion());
    }
    if (keyword === "version") {
      this.fail(head.column, problems.versionRepeated());
    } else if (keyword === "rule") {
      this.rule(tokens, lineLength);
    } else if (CLAUSES.has(keyword)) {
      this.clause(keyword, tokens, lineLength);
    } else {
      this.fail(head.column, problems.unknownStatement(head));
    }
  }

  /** Match `tokens` against `shape`; report the first mismatch. */
  private match(tokens: Token[], shape: readonly Expect[], lineLength: number): Token[] | null {
    for (let i = 0; i < shape.length; i++) {
      const want = shape[i] as Expect;
      const got = tokens[i];
      if (!got) {
        // Just after the last token (and one space), not past a trailing comment.
        const at = i > 0 ? (tokens[i - 1] as Token).end + 1 : lineLength + 1;
        this.fail(at, problems.expectedHere(want));
        return null;
      }
      if (!accepts(want, got)) {
        this.fail(got.column, problems.expectedFound(want, got));
        return null;
      }
    }
    const extra = tokens[shape.length];
    if (extra) {
      this.fail(extra.column, problems.extraToken(extra));
      return null;
    }
    return tokens;
  }

  private version(tokens: Token[], lineLength: number): void {
    const number = tokens[1];
    if (number?.kind === "word" && number.text !== "1" && tokens.length === 2) {
      this.fail(number.column, problems.unsupportedVersion(number.text));
      return;
    }
    this.match(tokens, [{ word: "version" }, { word: "1" }], lineLength);
  }

  /** Close the open rule and open a new one; false once the rule limit is hit. */
  private startRule(column: number): boolean {
    this.finishRule();
    this.ruleCount += 1;
    if (this.ruleCount > RULES_DSL_LIMITS.maxRules) {
      this.fail(column, problems.tooManyRules());
      this.stopped = true;
      return false;
    }
    this.current = {
      name: "",
      line: this.lineNo,
      column,
      note: null,
      disabled: null,
      sender: null,
      senderCount: 0,
      target: null,
      broken: false,
    };
    return true;
  }

  /**
   * A line that could not be tokenized. When it is a rule header, it still
   * opens a (broken) rule, so its clauses do not pile onto the rule above.
   */
  badLine(line: string, column: number, problem: DslProblem): void {
    const head = ruleHeaderColumn(line);
    if (head !== null && this.sawStatement && !this.startRule(head)) return;
    this.fail(column, problem);
  }

  private rule(tokens: Token[], lineLength: number): void {
    const head = tokens[0] as Token;
    if (!this.startRule(head.column) || !this.current) return;
    const matched = this.match(tokens, [{ word: "rule" }, { string: true }], lineLength);
    if (!matched) return;
    const name = matched[1] as Token;
    if (name.text.length > RULES_DSL_LIMITS.maxNameChars) {
      this.fail(name.column, problems.stringTooLong("name"));
    } else if (name.text.trim() === "") {
      this.fail(name.column, problems.emptyRuleName());
    }
    this.current.name = name.text;
  }

  private clause(keyword: string, tokens: Token[], lineLength: number): void {
    const head = tokens[0] as Token;
    const rule = this.current;
    if (!rule) {
      this.fail(head.column, problems.statementOutsideRule(keyword));
      return;
    }
    if (keyword === "when") this.senderClause(rule, tokens, lineLength);
    else if (keyword === "then") this.laneClause(rule, tokens, lineLength);
    else if (keyword === "note") this.noteClause(rule, tokens, lineLength);
    else if (rule.disabled !== null) this.duplicate(head, keyword);
    else if (this.match(tokens, [{ word: "disabled" }], lineLength)) rule.disabled = true;
  }

  private duplicate(head: Token, keyword: string): void {
    this.fail(head.column, problems.duplicateClause(keyword));
  }

  private senderClause(rule: RuleBuilder, tokens: Token[], lineLength: number): void {
    const head = tokens[0] as Token;
    rule.senderCount += 1;
    if (rule.senderCount > RULES_DSL_LIMITS.maxConditionsPerRule) {
      this.fail(head.column, problems.tooManyConditions());
      return;
    }
    const shape: Expect[] = [
      { word: "when" },
      { word: "from" },
      { oneOf: ["address", "domain"] },
      { string: true },
    ];
    const matched = this.match(tokens, shape, lineLength);
    if (!matched) return;
    const value = matched[3] as Token;
    if (value.text.length > RULES_DSL_LIMITS.maxValueChars) {
      this.fail(value.column, problems.stringTooLong("sender"));
      return;
    }
    rule.sender = {
      scope: (matched[2] as Token).text as AstWhen["scope"],
      value: value.text,
      line: this.lineNo,
      column: head.column,
      valueColumn: value.column,
    };
  }

  private laneClause(rule: RuleBuilder, tokens: Token[], lineLength: number): void {
    const head = tokens[0] as Token;
    if (rule.target) {
      this.duplicate(head, "then");
      return;
    }
    const matched = this.match(
      tokens,
      [{ word: "then" }, { word: "lane" }, { anyWord: true }],
      lineLength,
    );
    if (!matched) return;
    const laneToken = matched[2] as Token;
    const upper = asciiUpper(laneToken.text);
    if (RETIRED_LANES.has(upper)) {
      this.fail(laneToken.column, problems.retiredLane(laneToken.text));
      return;
    }
    if (!(DSL_LANES as readonly string[]).includes(upper)) {
      this.fail(laneToken.column, problems.unknownLane(laneToken.text));
      return;
    }
    rule.target = { lane: upper as DslLane, line: this.lineNo, column: head.column };
  }

  private noteClause(rule: RuleBuilder, tokens: Token[], lineLength: number): void {
    const head = tokens[0] as Token;
    if (rule.note !== null) {
      this.duplicate(head, "note");
      return;
    }
    const matched = this.match(tokens, [{ word: "note" }, { string: true }], lineLength);
    if (!matched) return;
    const text = matched[1] as Token;
    if (text.text.length > RULES_DSL_LIMITS.maxNoteChars) {
      this.fail(text.column, problems.stringTooLong("note"));
      return;
    }
    rule.note = text.text;
  }

  finishRule(): void {
    const rule = this.current;
    this.current = null;
    if (!rule || rule.broken) return;
    const at = (problem: DslProblem) =>
      this.errors.push({ line: rule.line, column: rule.column, ...problem });
    if (!rule.sender) at(problems.missingWhen());
    if (!rule.target) at(problems.missingThen());
    if (!rule.sender || !rule.target) return;
    this.rules.push({
      name: rule.name,
      note: rule.note,
      disabled: rule.disabled === true,
      sender: rule.sender,
      target: rule.target,
      line: rule.line,
      column: rule.column,
    });
  }

  finishFile(): void {
    this.finishRule();
    if (!this.sawStatement) {
      this.errors.push({ line: 1, column: 1, ...problems.missingVersion() });
    }
  }
}

function accepts(want: Expect, got: Token): boolean {
  if ("string" in want) return got.kind === "string";
  if (got.kind !== "word") return false;
  if ("word" in want) return got.text === want.word;
  if ("oneOf" in want) return want.oneOf.includes(got.text);
  return true;
}

/** Uppercase a-z only: `ſilent` must not fold into SILENT. */
function asciiUpper(text: string): string {
  let out = "";
  for (const ch of text) {
    out += ch >= "a" && ch <= "z" ? ch.toUpperCase() : ch;
  }
  return out;
}

/** Column of a leading `rule` keyword on a raw line, or null. */
function ruleHeaderColumn(line: string): number | null {
  let i = 0;
  while (line[i] === " " || line[i] === "\t") i += 1;
  if (!line.startsWith("rule", i)) return null;
  const next = line[i + 4];
  return next === undefined || next === " " || next === "\t" || next === '"' || next === "#"
    ? i + 1
    : null;
}

/** Sorted by position, capped: what every failure returns. */
export function failure(errors: DslError[]): DslFailure {
  const sorted = [...errors].sort((a, b) => a.line - b.line || a.column - b.column);
  const max = RULES_DSL_LIMITS.maxErrors;
  return { ok: false, errors: sorted.slice(0, max), truncated: sorted.length > max };
}

function* lines(text: string): Generator<string> {
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 ? text.length : end;
    const line = text.slice(start, stop);
    yield line.endsWith("\r") ? line.slice(0, -1) : line;
    if (end === -1) return;
    start = end + 1;
  }
}

export function parseRules(text: string): ParseResult {
  const max = RULES_DSL_LIMITS.maxTextBytes;
  if (utf8ByteLength(text, max) > max) {
    return failure([{ line: 1, column: 1, ...problems.textTooLarge() }]);
  }
  const parser = new Parser();
  let lineNo = 0;
  // One leading byte order mark (some editors add it) is not part of the text.
  const body = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  for (const line of lines(body)) {
    lineNo += 1;
    parser.setLine(lineNo);
    const bad = findForbidden(line);
    if (bad !== -1) {
      const hex = line.charCodeAt(bad).toString(16).toUpperCase().padStart(4, "0");
      parser.badLine(line, bad + 1, problems.forbiddenCharacter(hex));
    } else {
      const tokenized = tokenizeLine(line);
      if ("error" in tokenized) {
        const { column, ...problem } = tokenized.error;
        parser.badLine(line, column, problem);
      } else if (tokenized.tokens.length > 0) {
        parser.statement(tokenized.tokens, line.length);
      }
    }
    // Past the cap nothing more is reported, so stop working.
    if (parser.stopped || parser.errors.length > RULES_DSL_LIMITS.maxErrors) {
      return failure(parser.errors);
    }
  }
  parser.finishFile();
  if (parser.errors.length > 0) return failure(parser.errors);
  return { ok: true, ast: { version: 1, rules: parser.rules } };
}
