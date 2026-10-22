import { CommanderError } from "commander";
import { buildInfo } from "./build.js";
import { createProgram, USER_TOOLS } from "./commands.js";
import { CredentialStore } from "./credentials.js";
import { ToolError } from "./errors.js";
import { HttpClient } from "./http.js";
import { UserAuth, userAgent } from "./auth.js";
import { writeToolError } from "./tool.js";

export async function main(argv = process.argv): Promise<number> {
  const client = new HttpClient(buildInfo.apiURL, userAgent(buildInfo.version));
  const auth = new UserAuth(client, buildInfo.apiURL, new CredentialStore());
  const program = createProgram({ client, auth });
  program.exitOverride();
  try {
    if (argv.length <= 2) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.version"].includes(error.code)) return 0;
    if (error instanceof ToolError) {
      writeToolError(error);
      return 1;
    }
    if (isBusinessCommand(argv[2])) {
      writeToolError(new ToolError({
        code: "invalid_arguments",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      }, crypto.randomUUID()));
      return 1;
    }
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isBusinessCommand(command: string | undefined): boolean {
  return command === "capabilities" || USER_TOOLS.some((tool) => tool.split(" ")[0] === command);
}

process.exitCode = await main();
