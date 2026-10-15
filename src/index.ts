import { startServer, version } from "./server.js";

// Print version and exit before starting the stdio server, so the launcher and
// MCP hosts can probe the server with `--version`.
const subcommand = process.argv[2];
if (subcommand === "--version" || subcommand === "-V") {
  process.stdout.write(`terraform-cwd-mcp ${version}\n`);
  process.exit(0);
}

startServer().catch((err) => {
  console.error("terraform-cwd-mcp error:", err);
  process.exit(1);
});
