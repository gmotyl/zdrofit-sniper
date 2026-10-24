#!/usr/bin/env node
// Entry point: dispatches the `setup` and `daemon` subcommands.

const HELP = `Usage: sniper <command>

Commands:
  setup    Interactive wizard: manage users and snipers
  daemon   Sleep until the next booking opening and book

Options:
  -h, --help  Show this help
`;

export async function main(argv: string[]): Promise<number> {
  const [command] = argv;

  switch (command) {
    case "setup":
      console.error("setup: not implemented yet");
      return 1;
    case "daemon":
      console.error("daemon: not implemented yet");
      return 1;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
