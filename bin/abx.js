#!/usr/bin/env bun
// Installed package (no src/): run the bundle. Repo checkout: run the TypeScript sources, so
// workspace extensions always use the current CLI without a rebuild.
import { existsSync } from "node:fs";

const src = new URL("../src/cli.ts", import.meta.url);
await import(existsSync(src) ? src.href : new URL("../dist/cli.js", import.meta.url).href);
