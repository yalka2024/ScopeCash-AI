// Prisma config used for the Postgres production schema.
// Run with: prisma migrate deploy --config prisma.postgres.config.ts
//
// DIRECT_URL is required when DATABASE_URL points at a pooled connection
// (PgBouncer, Supabase pooler, Neon pooler) — Prisma migrations need a
// direct, unpooled connection. Falls back to DATABASE_URL otherwise.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.postgres.prisma",
  migrations: {
    path: "prisma/migrations-postgres",
  },
  datasource: {
    // Build-time placeholder so `prisma generate` works without env present; the real
    // DIRECT_URL/DATABASE_URL is used at migrate/runtime (generate never connects).
    url: process.env["DIRECT_URL"] || process.env["DATABASE_URL"] || "postgresql://localhost:5432/_buildtime",
  },
});

