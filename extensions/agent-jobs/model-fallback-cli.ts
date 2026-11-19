// Used by run.sh: `node model-fallback-cli.ts <events.jsonl> <stderr.log>` exits 0 only when the attempt's
// provider was unavailable. Any other exit, including a crash here, keeps the job on its current result.
import { readFileSync } from "node:fs";
import { providerUnavailableReason } from "./model-fallback.ts";

const readOrEmpty = (file: string | undefined) => {
	try { return file ? readFileSync(file, "utf8") : ""; } catch { return ""; }
};
process.exit(providerUnavailableReason(readOrEmpty(process.argv[2]), readOrEmpty(process.argv[3])) ? 0 : 1);
