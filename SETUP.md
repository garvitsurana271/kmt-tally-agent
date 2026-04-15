# Tally Agent Setup

## One-time configuration

Create a file called `.env` in this folder (next to `tally.js`) with the Supabase service role key:

```
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5eGR5cWlubmV0Y2JybG5wZ3l4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDU5ODA2OCwiZXhwIjoyMDkwMTc0MDY4fQ.q2Bd-CWk7aOvZ8cqRR5RJtadrJ9RazvIbjVw3xUvDn0
```

This file is gitignored and will never be committed to git.

## Start the agent

```
node tally.js
```
