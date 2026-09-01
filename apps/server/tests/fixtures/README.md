# Codex event fixtures

These sanitised JSONL captures preserve real Codex event shapes for the
normalisation contract tests.

- `codex-run.jsonl` covers a complete run, including reasoning, messages,
  commands, usage, and a Codex diagnostic item.
- `codex-file-change.jsonl` covers the canonical file-change mapping.
- `codex-todo-list.jsonl` covers the plan Codex maintains through `update_plan`.
  Its `items` payloads are taken verbatim from a real run; the surrounding
  `item.started` / `item.updated` / `item.completed` envelope is reconstructed,
  because only the normalised events were retained from that run. The envelope
  shape is verified independently by the two fixtures above.

The fixtures are committed with the tests. They must not contain API keys,
tokens, credentials, or other live secrets.
