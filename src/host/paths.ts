import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ResolveRunnerOptions {
	fromDir?: string;
	bbDbPath?: string;
	cacheDir?: string;
	env?: NodeJS.ProcessEnv;
}

export function getBbDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const custom = env.BB_DATA_DIR?.trim();
	if (custom) return resolve(custom);
	return join(homedir(), ".bb");
}

function findRunnerFromDb(dbPath: string): string | null {
	if (!existsSync(dbPath)) return null;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const query = `
				SELECT root_dir FROM plugins
				WHERE (id = 'provider-pi-durable' OR id = 'bb-plugin-provider-pi-durable')
				ORDER BY enabled DESC, updated_at DESC
				LIMIT 1
			`;
			const row = db.prepare(query).get() as { root_dir?: string } | undefined;
			if (row?.root_dir) {
				const candidate = resolve(row.root_dir, "dist", "runner", "index.js");
				if (existsSync(candidate)) return candidate;
				const srcCandidate = resolve(row.root_dir, "runner", "index.js");
				if (existsSync(srcCandidate)) return srcCandidate;
			}
		} finally {
			db.close();
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT" && code !== "SQLITE_CANTOPEN") {
			console.warn(`[Paths] SQLite inspection warning for ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return null;
}

function findRunnerInCache(cacheRoot: string, maxDepth = 5): string | null {
	if (!existsSync(cacheRoot)) return null;
	const queue: { dir: string; depth: number }[] = [{ dir: cacheRoot, depth: 0 }];
	while (queue.length > 0) {
		const { dir, depth } = queue.shift()!;
		if (depth > maxDepth) continue;
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				const full = join(dir, entry.name);
				const candidate = join(full, "dist", "runner", "index.js");
				if (existsSync(candidate)) return candidate;
				const srcCandidate = join(full, "runner", "index.js");
				if (existsSync(srcCandidate)) return srcCandidate;
				queue.push({ dir: full, depth: depth + 1 });
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT") {
				console.warn(`[Paths] Directory traversal warning for ${dir}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	return null;
}

export function resolveRunnerPath(options?: ResolveRunnerOptions): string {
	const env = options?.env ?? process.env;
	const envCmd = env.BB_PI_DURABLE_BRIDGE_COMMAND?.trim() || env.PI_DURABLE_RUNNER_PATH?.trim();
	if (envCmd) {
		const custom = resolve(envCmd);
		if (existsSync(custom)) return custom;
	}

	const baseDir = options?.fromDir ? resolve(options.fromDir) : __dirname;
	const directCandidates = [
		resolve(baseDir, "dist", "runner", "index.js"),
		resolve(baseDir, "runner", "index.js"),
		resolve(baseDir, "..", "runner", "index.js"),
		resolve(baseDir, "..", "dist", "runner", "index.js"),
		resolve(baseDir, "..", "..", "dist", "runner", "index.js"),
	];

	for (const candidate of directCandidates) {
		if (existsSync(candidate)) return candidate;
	}

	const dataDir = getBbDataDir(env);
	const legacyDataDir = join(homedir(), ".bb");
	const isCustomDataDir = dataDir !== legacyDataDir;

	const bbDbPath = options?.bbDbPath ?? join(dataDir, "bb.db");
	let dbRunner = findRunnerFromDb(bbDbPath);
	if (!dbRunner && isCustomDataDir && !options?.bbDbPath) {
		dbRunner = findRunnerFromDb(join(legacyDataDir, "bb.db"));
	}
	if (dbRunner) return dbRunner;

	const cacheRoots = options?.cacheDir
		? [join(options.cacheDir, "git"), join(options.cacheDir, "npm"), options.cacheDir]
		: [
				join(dataDir, "plugins", "cache", "git"),
				join(dataDir, "plugins", "cache", "npm"),
				...(isCustomDataDir
					? [
							join(legacyDataDir, "plugins", "cache", "git"),
							join(legacyDataDir, "plugins", "cache", "npm"),
						]
					: []),
		  ];

	for (const cr of cacheRoots) {
		const found = findRunnerInCache(cr);
		if (found) return found;
	}

	const bbPluginCandidates = [
		join(dataDir, "plugins", "provider-pi-durable", "dist", "runner", "index.js"),
		join(dataDir, "plugins", "bb-plugin-provider-pi-durable", "dist", "runner", "index.js"),
		...(isCustomDataDir
			? [
					join(legacyDataDir, "plugins", "provider-pi-durable", "dist", "runner", "index.js"),
					join(legacyDataDir, "plugins", "bb-plugin-provider-pi-durable", "dist", "runner", "index.js"),
			  ]
			: []),
	];
	for (const candidate of bbPluginCandidates) {
		if (existsSync(candidate)) return candidate;
	}

	const parentDir = dirname(baseDir);
	try {
		if (existsSync(parentDir)) {
			const siblings = readdirSync(parentDir, { withFileTypes: true });
			for (const sib of siblings) {
				if (sib.isDirectory()) {
					const sibRunner = resolve(parentDir, sib.name, "dist", "runner", "index.js");
					if (existsSync(sibRunner)) return sibRunner;
					const sibDirectRunner = resolve(parentDir, sib.name, "runner", "index.js");
					if (existsSync(sibDirectRunner)) return sibDirectRunner;
				}
			}
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT") {
			console.warn(`[Paths] Sibling traversal warning for ${parentDir}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const allSearched = [...directCandidates, `bb.db: ${bbDbPath}`, ...cacheRoots, ...bbPluginCandidates];

	throw new Error(
		`Pi Durable internal runner bundle not found. Searched in: ${allSearched.join(", ")}. Please build the plugin using "npm run build" or set PI_DURABLE_RUNNER_PATH.`,
	);
}

export function resolveSessionDir(env: NodeJS.ProcessEnv = process.env): string {
	const custom = env.BB_PI_BRIDGE_SESSION_DIR?.trim();
	if (custom) return resolve(custom);
	return join(getBbDataDir(env), "pi-bridge-sessions");
}

export function resolveSessionFilePath(threadId: string, env: NodeJS.ProcessEnv = process.env): string {
	const sanitized = threadId.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(resolveSessionDir(env), sanitized);
}

let activeScratchDir: string | null = null;
export function requireScratchDir(): string {
	if (!activeScratchDir) {
		activeScratchDir = join(tmpdir(), `bb-pi-bridge-${process.pid}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(activeScratchDir, { recursive: true });
	}
	return activeScratchDir;
}

let activeExtensionPath: string | null = null;
export function requireExtensionPath(): string {
	if (!activeExtensionPath) {
		const scratch = requireScratchDir();
		const extFile = join(scratch, "bb-pi-extension.mjs");
		writeFileSync(
			extFile,
			`// Pi Durable BB Bridge stub extension
export default function (pi) {
  // Bridge side channel active
}
`,
			"utf8",
		);
		activeExtensionPath = extFile;
	}
	return activeExtensionPath;
}
