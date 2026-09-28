# Techloop Pharma — Backend

Node.js + Express 5 + TypeScript + MongoDB (Mongoose). Phase 1: auth, users, roles.

## Setup

```bash
cp .env.example .env   # fill MONGODB_URI, JWT_SECRET (>= 32 chars), CORS_ORIGIN, SEED_OWNER_PASSWORD
npm install
npm run seed           # creates the first OWNER (skipped if one exists)
npm run dev
```

## API

| Method | Path                    | Access       |
| ------ | ----------------------- | ------------ |
| POST   | /api/auth/login         | public       |
| GET    | /api/auth/me            | any user     |
| POST   | /api/users              | OWNER, ADMIN |
| GET    | /api/users              | OWNER, ADMIN |
| GET    | /api/users/:id          | OWNER, ADMIN |
| PATCH  | /api/users/:id          | OWNER, ADMIN |
| PATCH  | /api/users/:id/status   | OWNER, ADMIN |

Rules: `OWNER` can't be created or assigned via the API (seed only); only an owner can edit an owner;
users can't change their own status. Deactivated users' existing tokens stop working immediately.
