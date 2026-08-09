/*
 * Prints an argon2 hash of a master password for MASTER_PASSWORD_HASH.
 *
 *   npm run hash-master                 -> prompts, input hidden
 *   npm run hash-master -- "the pass"   -> non-interactive (shell history!)
 *
 * The password itself is never written anywhere — only the hash is printed, and
 * the hash is what goes in .env.
 */
import readline from "node:readline";
import { hashPassword, passwordProblems } from "../src/lib/password";

async function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  // Suppress the echo of everything after the prompt itself.
  const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
  let muted = false;
  output._writeToOutput = (str: string) => {
    if (!muted) output.output.write(str);
    else if (str.includes("\n")) output.output.write("\n");
  };

  const answer = await new Promise<string>((resolve) => {
    rl.question(question, (value) => resolve(value));
    muted = true;
  });

  rl.close();
  return answer;
}

async function main() {
  const fromArgs = process.argv.slice(2).join(" ").trim();
  const password = fromArgs || (await promptHidden("Master password: "));

  if (!password) {
    console.error("No password given.");
    process.exit(1);
  }

  const problems = passwordProblems(password);
  if (problems.length > 0) {
    console.error("\nThat password does not meet the policy:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nThe master account is the platform's root credential. Pick a stronger one.");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  console.log("\nPaste this into .env (the whole line, quotes not needed):\n");
  console.log(`MASTER_PASSWORD_HASH=${hash}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
