import { describe, expect, it } from "vitest";
import { ESCAPED_JSON_SECRET_FIELD_TEXT_RE, JSON_SECRET_FIELD_TEXT_RE, redactSensitiveText } from "../redaction.js";

// Reference copies of the pre-fix regexes (no word-start lookbehind), used to
// prove the optimized ones produce byte-identical output.
const NAME = String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization(?:[-_]?code)?|bearer|secrets?|passwd|passwords?|credentials?|jwt|private[-_]?key|cookie|connectionstring|browser[-_]?code|login[-_]?url)(?:[-_]?(?:value|header|prod(?:uction)?|dev(?:elopment)?|test|staging|primary|secondary))*`;
const OLD_JSON = new RegExp(
  String.raw`((?:"|')?${NAME}(?:"|')?\s*:\s*(?:"|'))[^"'` + "`" + String.raw`\r\n]+((?:"|'))`,
  "gi",
);
const OLD_ESCAPED = new RegExp(String.raw`((?:\\")?${NAME}(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))`, "gi");
const MASK = "***REDACTED***";
const oldRedact = (s: string) =>
  s.replace(OLD_JSON, `$1${MASK}$2`).replace(OLD_ESCAPED, `$1${MASK}$2`);
const newRedact = (s: string) =>
  s
    .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${MASK}$2`)
    .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${MASK}$2`);

describe("secret field text redaction", () => {
  const cases = [
    `{"apiKey": "sk-abc123456789", "name": "x"}`,
    `{"api_key":"v1","accessToken":'v2',"x-auth-token": "v3"}`,
    `{\\"password\\": \\"hunter2hunter2\\", \\"ok\\": 1}`,
    `{"event":"{\\"authToken\\":\\"abc.def.ghi\\",\\"n\\":1}"}`,
    `{"message":"{\\"nested\\":{\\"clientSecret\\":\\"zzzzzzzz\\"}}"}`,
    `"myCustomApiKeyProduction": "value-with-dashes"`,
    `prefix_with_underscores-and-dashes_token: "abcdef"`,
    `xapiKey: "v" a"apiKey":"v2" 9token:'t'`,
    `{"cookie":\n"line1\nline2", "secret":\r\n"x"}`,
    `{"secrets": "a", "credentials":"b", "jwt": "c", "privateKey":"d", "connectionString":"e"}`,
    `{"tokenPolicy": "least privilege", "credentialHandling": "harness"}`,
    `plain text with a token word but no json and a.dot`,
    `{"Token" : "A" , "TOKEN":"B", "bearer": "C"}`,
    `{"a":"apikey"} {"apikey":""} {"apikey": "x`,
    `{"api-key-value": "v", "tokenprod": "p", "secret_staging_primary": "q"}`,
  ];

  it.each(cases.map((c, i) => [i, c] as const))("matches the pre-fix regex output for case %i", (_i, input) => {
    expect(newRedact(input)).toBe(oldRedact(input));
    expect(redactSensitiveText(input)).not.toContain("hunter2hunter2");
  });

  it("produces identical output to the pre-fix regexes on a generated corpus", () => {
    const words = ["a", "api", "apiKey", "x-auth_token", "Token", "secret", "name", "9", "foo_bar"];
    const seps = [`":"`, `": "`, `\\":\\"`, `:'`, ` : "`, `\n"`, `":`, `"`, " ", "-", "_", "."];
    const tails = [`v1"`, `v2'`, `\\"`, `abc"`, `"`, `x\\"`];
    let n = 0;
    for (const w1 of words) for (const w2 of words) for (const sep of seps) for (const t of tails) {
      const input = `{"${w1}${w2}${sep}secretvalue${t}}`;
      expect(newRedact(input)).toBe(oldRedact(input));
      n++;
    }
    expect(n).toBeGreaterThan(1000);
  });

  it("redacts a large synthetic Pi-style log within a time bound the quadratic regex fails", () => {
    // Long unbroken words (base64-like payloads) with no secret field names are
    // the quadratic worst case for an unanchored `[A-Za-z0-9_-]*` prefix.
    const word = "A1b2C3d4_".repeat(1500); // ~13.5 KB single word
    const chunk = `{"type":"message_end","message":{"content":[{"text":"${word}.tail"}],"apiKey":"sk-live-secret-1234"}}\n`;
    const log = chunk.repeat(20); // ~270 KB

    const start = performance.now();
    const out = redactSensitiveText(log);
    const elapsed = performance.now() - start;

    expect(out).not.toContain("sk-live-secret-1234");
    expect(out).toContain(MASK);
    expect(elapsed).toBeLessThan(500);

    // Sanity: the reference regex is far slower on the same input (checked on a
    // single chunk to keep the test cheap).
    const oldStart = performance.now();
    oldRedact(chunk);
    const oldElapsed = performance.now() - oldStart;
    expect(oldElapsed).toBeGreaterThan(elapsed / 20 * 5);
  });
});
