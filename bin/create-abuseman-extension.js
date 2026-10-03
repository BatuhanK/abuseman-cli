#!/usr/bin/env bun
// `bun create abuseman-extension <dir>`: see bin/abx.js for the src/dist choice.
import { existsSync } from "node:fs";

const src = new URL("../src/create-bin.ts", import.meta.url);
await import(existsSync(src) ? src.href : new URL("../dist/create-bin.js", import.meta.url).href);
