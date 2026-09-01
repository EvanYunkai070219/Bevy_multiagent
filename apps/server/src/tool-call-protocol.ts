/**
 * DeepSeek sometimes emits DSML tool-call syntax inside assistant text instead
 * of using the Responses tool-call channel. That is not executable output.
 */
export function looksLikeUnparsedToolCall(text: string): boolean {
  return (
    /<[｜|]\s*DSML\s*[｜|]\s*tool_calls\s*>/i.test(text) &&
    /<[^>]*\b(?:invoke|parameter)\s+name\s*=/i.test(text)
  );
}

export class ToolCallProtocolError extends Error {
  readonly name = "ToolCallProtocolError";

  constructor(message = "Model emitted tool-call markup as assistant text after protocol recovery") {
    super(message);
  }
}
