# Routine Test Ping

Proof-of-life for the routine monitor — confirms a routine still fires correctly. No side effects beyond a log line.

## Steps

Append one line to `.claude-code-hermit/sessions/SHELL.md` under `## Monitoring`:

```
[HH:MM] routine-test-ping: fired.
```

Stop. No channel send, no further checks.
