import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const queues = new Map<string, Promise<void>>();
const delay = () => new Promise(resolve => setTimeout(resolve, 20));
interface Contender { pid: number; choosing: boolean; ticket: number }

async function readContender(file: string): Promise<Contender | undefined> {
	let handle;
	try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > 512) throw new Error("Invalid lifecycle lock artifact.");
		const owner = JSON.parse(await handle.readFile("utf8")) as Contender;
		if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.choosing !== "boolean" || !Number.isSafeInteger(owner.ticket) || owner.ticket < 0 || (!owner.choosing && owner.ticket === 0)) throw new Error("Invalid lifecycle lock owner.");
		try { process.kill(owner.pid, 0); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined; throw error; }
		return owner;
	} finally { await handle.close(); }
}

async function withFileLock<T>(jobDir: string, action: () => Promise<T>): Promise<T> {
	const directory = join(jobDir, ".lifecycle");
	await fs.mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
	const stat = await fs.lstat(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid lifecycle lock directory.");
	const name = `${process.pid}-${randomBytes(16).toString("hex")}.json`;
	const file = join(directory, name);
	const temporary = `${file}.tmp`;
	async function publish(owner: Contender) {
		await fs.writeFile(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, file);
	}
	async function peers() {
		const names = (await fs.readdir(directory)).filter(entry => /^\d+-[a-f0-9]{32}\.json$/.test(entry) && entry !== name);
		const entries = await Promise.all(names.map(async peer => ({ name: peer, owner: await readContender(join(directory, peer)) })));
		return entries.filter((entry): entry is { name: string; owner: Contender } => entry.owner !== undefined);
	}
	try {
		// Bakery ordering avoids deleting another process's lock during stale-owner recovery.
		// Publish the choosing phase before selecting a ticket; only remove our own file.
		await publish({ pid: process.pid, choosing: true, ticket: 0 });
		const ticket = Math.max(0, ...(await peers()).map(peer => peer.owner.ticket)) + 1;
		if (!Number.isSafeInteger(ticket)) throw new Error("Lifecycle lock ticket overflow.");
		await publish({ pid: process.pid, choosing: false, ticket });
		const deadline = Date.now() + 10_000;
		while ((await peers()).some(peer => peer.owner.choosing || peer.owner.ticket < ticket || (peer.owner.ticket === ticket && peer.name < name))) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the job lifecycle lock.");
			await delay();
		}
		return await action();
	} finally {
		await fs.rm(temporary, { force: true });
		await fs.rm(file, { force: true });
	}
}

/** Serialize complete read/modify/write transitions, including across Pi processes. */
export async function withJobLock<T>(jobDir: string, action: () => Promise<T>): Promise<T> {
	const previous = queues.get(jobDir) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(() => withFileLock(jobDir, action));
	const marker = current.then(() => undefined, () => undefined);
	queues.set(jobDir, marker);
	try { return await current; }
	finally { if (queues.get(jobDir) === marker) queues.delete(jobDir); }
}
