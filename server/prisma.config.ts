import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Fall back to a local SQLite url so `prisma generate` (run by `npm install`'s
    // postinstall) works before a .env exists. At runtime the real DATABASE_URL wins.
    url: process.env["DATABASE_URL"] || "file:./dev.db",
  },
});

