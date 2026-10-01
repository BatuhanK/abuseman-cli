#!/usr/bin/env bun
/** `bun create abuseman-extension <dir>` / `create-abuseman-extension <dir>` */
import { run } from "./index";

process.exit(await run(["create", ...process.argv.slice(2)]));
