# AssetFlow — Enterprise Asset & Resource Management System

AssetFlow is a centralized ERP for tracking, allocating, and maintaining an
organization's physical assets and shared resources — assets, allocations &
transfers, resource bookings, a maintenance approval workflow, audit cycles,
reports, and role-based dashboards for Admin, Asset Manager, Department Head,
and Employee.

Built for the Odoo Hackathon with **React + TypeScript + Vite + Tailwind**
(frontend) and **NestJS + PostgreSQL + Prisma** (backend, in [`backend/`](backend)).

---

## ▶️ Run the demo (no backend or database needed)

The frontend runs **standalone on realistic demo data** — perfect for trying it
on any laptop or recording a walkthrough.

```bash
npm install
npm run dev      # open http://localhost:5173
```

### Demo accounts
Sign in with any of these emails and **any password** — each shows that role's
dashboard and screens:

| Email | Role you experience |
|-------|---------------------|
| `admin@assetflow.com` | **Admin** — org setup, all analytics |
| `manager@assetflow.com` | **Asset Manager** — register/allocate assets, approvals |
| `head@assetflow.com` | **Department Head** — department view + approvals |
| `employee@assetflow.com` | **Employee** — my assets, book resources, raise requests |

Any other email signs in as an Employee. (Sign-up also creates an Employee.)

### What you can show in the demo
Log in as each role and walk the sidebar: **Dashboard** (role-specific KPIs),
**Asset Directory**, **Allocations & Transfers**, **Resource Booking**,
**Maintenance**, **Asset Audits**, **Reports & Analytics**, **Organization
Setup** (Admin). Data shown is representative demo data.

---

## 🔌 Running against the real backend (optional)

The full REST API lives in [`backend/`](backend) (NestJS + Postgres + Prisma) and
is documented in [`backend/API.md`](backend/API.md). It implements all 10 features
with real auth (JWT), RBAC, and workflow logic, and is covered by end-to-end
tests. See [`backend/README.md`](backend/README.md) to run it (Docker Postgres +
`npm run start:dev`, serving `http://localhost:4000/api`).

The frontend reads its API origin from `VITE_API_BASE_URL` (see
[`.env.example`](.env.example)) and falls back to `http://localhost:4000/api`,
so running both servers locally needs no extra configuration.

> Note: the demo UI currently uses built-in demo data so it runs anywhere with
> zero setup. Wiring the live API into every screen (aligning endpoint paths and
> auth) is the remaining integration step; the backend contract is ready in
> `backend/API.md`.

---

## 🚀 Deploying to Vercel

The repo deploys as **two Vercel projects from the same GitHub repo** — one for
the React frontend (repo root) and one for the NestJS API (`backend/`). Each
folder has its own `vercel.json`.

### 0. Prerequisites
- The Neon Postgres database (already created), and its pooled connection string.
- The schema applied to it (`cd backend && npx prisma migrate deploy`) and,
  optionally, demo data (`npm run seed`).

### 1. Deploy the API (do this first — you need its URL for step 2)
1. Go to <https://vercel.com/new> and import `BhaveshSab/odoohackathon`.
2. Set **Root Directory** to `backend`.
3. Leave the build settings alone — `backend/vercel.json` already sets
   `prisma generate && nest build` and routes every request to the serverless
   entrypoint `backend/api/index.js`.
4. Add these **Environment Variables** (Production + Preview):

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | your Neon **pooled** connection string (`...-pooler...?sslmode=require`) |
   | `JWT_SECRET` | a fresh secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
   | `JWT_EXPIRES_IN` | `7d` |
   | `CORS_ORIGINS` | fill in after step 2, then redeploy |

   Do **not** set `PORT` — Vercel manages it.
5. Click **Deploy**, then confirm `https://<api-project>.vercel.app/api` returns
   `Hello World!`.

### 2. Deploy the frontend
1. Import the **same repo** again as a second Vercel project.
2. Leave **Root Directory** as the repo root. `vercel.json` sets the Vite build
   (`npm run build` → `dist`) and the SPA rewrite so deep links like
   `/Dashboard` don't 404.
3. Add one environment variable:

   | Key | Value |
   |-----|-------|
   | `VITE_API_BASE_URL` | `https://<api-project>.vercel.app/api` |

   Vite inlines this at build time, so changing it later requires a redeploy.
4. Click **Deploy**.

### 3. Close the CORS loop
Back in the **API** project, set
`CORS_ORIGINS=https://<frontend-project>.vercel.app` (comma-separate extra
origins, no trailing slash) and redeploy. Without this the browser blocks every
API call.

### 4. Verify
Open the frontend URL, sign in as `admin@assetflow.com` / `password123`, and
confirm the dashboard loads live data. If requests fail, check the API project's
runtime logs in Vercel.

> **Note on Neon connectivity:** `PrismaService` routes `*.neon.tech` URLs
> through `@prisma/adapter-neon`, which tunnels Postgres over WebSocket on port
> 443. That's required on networks that block raw Postgres TCP (5432) and works
> well on serverless. Any other `DATABASE_URL` (e.g. local Docker Postgres)
> still uses Prisma's default TCP engine.

---

## Tech stack
- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Recharts, Framer Motion
- **Backend:** NestJS, TypeScript, PostgreSQL, Prisma, JWT + bcrypt
