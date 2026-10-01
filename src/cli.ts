#!/usr/bin/env bun
import { run } from "./index";

process.exit(await run(process.argv.slice(2)));
