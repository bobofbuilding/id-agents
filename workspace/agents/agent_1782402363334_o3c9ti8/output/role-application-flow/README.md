# Bittrees contributor role-application flow

This is a local-only implementation of the contributor portal's role-application submit/review slice. It deliberately has no deployment configuration and binds the runnable harness to `127.0.0.1`.

## Contract

The persisted `RoleApplication` record is:

```text
id: string                 UUID
roleId: string             requested contributor role
applicantId: string        authenticated local agent ID
applicantName: string      authenticated local display name
motivation: string         required application statement
experience?: string
evidenceUrls?: string[]
status: submitted | under_review | approved | rejected
submittedAt: ISO timestamp
updatedAt: ISO timestamp
reviewedAt?: ISO timestamp
reviewedBy?: string
reviewNote?: string
version: positive integer  optimistic concurrency token
```

The repository writes to a temporary file and atomically renames it into `data/role-applications.json`. Mutations are serialized in-process. The HTTP layer depends only on the repository interface, leaving a future SQLite/Postgres migration isolated.

## Routes

All routes require an authenticated principal. The executable harness uses local-session headers solely for local testing: `x-local-user-id`, `x-local-user-name`, and (for reviewers) `x-local-reviewer: true`. A production adapter must replace `defaultLocalAuthenticator` with the portal's real session middleware.

| Method | Route | Access | Result |
| --- | --- | --- | --- |
| `POST` | `/api/role-applications` | applicant | Creates a `submitted` application; identity is taken from the session, never the JSON body. |
| `GET` | `/api/role-applications/mine` | applicant | Lists the current applicant's applications. |
| `GET` | `/api/role-applications?status=&roleId=` | reviewer | Lists applications with optional filters. |
| `GET` | `/api/role-applications/:id` | owner or reviewer | Returns one application; inaccessible records are `404`. |
| `PATCH` | `/api/role-applications/:id/review` | reviewer | Accepts `{ decision, reviewNote?, expectedVersion }`; terminal decisions cannot change. |

Important responses include `201` for submission, `400` for invalid input, `401` for no session, `403` for reviewer-only routes, `404` for missing/inaccessible records, and `409` for duplicate active applications or stale/terminal reviews.

## Local validation

```sh
npm test
npm start
```

`npm test` uses an ephemeral temporary JSON store and loopback HTTP servers. `npm start` defaults to port `4101`; set `PORT` and `ROLE_APPLICATION_DATA_FILE` only for local validation. No live/public exposure is introduced by this artifact.
