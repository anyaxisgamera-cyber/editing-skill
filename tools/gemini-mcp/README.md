# Gemini MCP server

A small, dependency-free MCP server that lets Claude Code call Google AI Studio (Gemini) models.

## Tools

- `gemini_ask`: send a prompt (`prompt`, optional `model`, `system`, `temperature`, `max_output_tokens`).
- `gemini_list_models`: list the text-generation models your key can use, and the default.

## API key

The key is never stored in this repo. In a Claude Code cloud environment, add it as a
Network secret: host `generativelanguage.googleapis.com`, header `x-goog-api-key`, no prefix.
The proxy adds it to each request. Elsewhere, set `GEMINI_API_KEY` in your shell.

Optional: `GEMINI_DEFAULT_MODEL` pins the default model; otherwise the newest stable Flash model is used.

## Register

```bash
claude mcp add -s user gemini -- node "$PWD/tools/gemini-mcp/server.js"
```

Remove with `claude mcp remove -s user gemini`.
