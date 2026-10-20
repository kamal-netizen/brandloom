<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Brandloom notes for agents

- Publishing to a brand's Instagram is public and irreversible. Never add a path that
  reaches `media_publish` without a person's approval (see src/lib/posts.ts header),
  and never grant `posts:approve` to a token unless the user asks.
- Raw SQL against DateTime columns: they are `timestamp without time zone` holding UTC.
  Never compare them with `now()`; bind the time (see claimDue in src/lib/publish/engine.ts).
- `prisma migrate reset` is blocked for agents; tests use `migrate deploy` on brandloom_test.
- Times shown or parsed for people are Asia/Dubai (src/lib/time.ts).
