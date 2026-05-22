#!/usr/bin/env node
import { existsSync } from "node:fs";
import chalk from "chalk";
import { program } from "commander";
import { probe } from "../core/probe.js";
import { loadScenarios } from "../scenario/loader.js";

program.name("klorn").description("Test and evaluate AI coding agents").version("0.2.2");

program
  .command("run")
  .description("Run scenario(s) against an agent")
  .argument("<files...>", "YAML scenario file(s)")
  .option("-o, --output <dir>", "Output directory for reports", "./results")
  .option("--md", "Generate markdown report", false)
  .option("-v, --verbose", "Verbose output", false)
  .action(async (files: string[], opts: { output: string; md: boolean; verbose: boolean }) => {
    try {
      // Validate files exist before loading
      const missing = files.filter((f) => !existsSync(f));
      if (missing.length > 0) {
        console.error(chalk.red(`File(s) not found:\n  ${missing.join("\n  ")}`));
        process.exit(1);
      }

      const scenarios = loadScenarios(files);
      if (scenarios.length === 0) {
        console.error(chalk.yellow("No valid scenarios to run."));
        process.exit(1);
      }

      const results = await probe(scenarios, {
        outputDir: opts.output,
        markdown: opts.md,
        verbose: opts.verbose,
      });

      const failed = results.filter((r) => !r.evaluation.passed).length;
      process.exit(failed > 0 ? 1 : 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${msg}`));
      process.exit(1);
    }
  });

program
  .command("validate")
  .description("Validate scenario file(s) without running")
  .argument("<files...>", "YAML scenario file(s)")
  .action((files: string[]) => {
    let hasError = false;
    for (const file of files) {
      if (!existsSync(file)) {
        console.log(chalk.red(`  FAIL: ${file} — file not found`));
        hasError = true;
        continue;
      }
      try {
        loadScenarios([file]);
        console.log(chalk.green(`  OK: ${file}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`  FAIL: ${file} — ${msg}`));
        hasError = true;
      }
    }
    process.exit(hasError ? 1 : 0);
  });

program.parse();
