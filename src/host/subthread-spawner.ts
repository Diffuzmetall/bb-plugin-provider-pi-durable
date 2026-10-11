import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SubthreadSpawnArgs {
	projectId?: string;
	parentThreadId: string;
	title: string;
	task: string;
	conversationId: string;
}

export interface ThreadRegistrationTarget {
	registerThread(threadId: string, conversationId?: string): void;
}

export interface SubthreadSpawnerOptions {
	execCommand?: (cmd: string, args: string[]) => Promise<string>;
}

export function buildSpawnArgs(args: SubthreadSpawnArgs): string[] {
	const projectId = args.projectId || process.env.BB_PROJECT_ID || "proj_personal";
	return [
		"thread",
		"spawn",
		"--project",
		projectId,
		"--parent-thread",
		args.parentThreadId,
		"--title",
		args.title,
		"--prompt",
		args.task,
		"--provider",
		"pi-durable",
		"--json",
	];
}

export async function spawnSubthreadInBb(
	args: SubthreadSpawnArgs,
	session: ThreadRegistrationTarget,
	options: SubthreadSpawnerOptions = {},
): Promise<string | undefined> {
	const cliArgs = buildSpawnArgs(args);
	try {
		let output = "";
		if (options.execCommand) {
			output = await options.execCommand("bb", cliArgs);
		} else {
			const cliBinary = process.env.BB_CLI || "bb";
			const res = await execFileAsync(cliBinary, cliArgs, {
				timeout: 15000,
				env: { ...process.env },
			});
			output = res.stdout;
		}

		const parsed = JSON.parse(output.trim());
		if (parsed && typeof parsed.id === "string") {
			session.registerThread(parsed.id, args.conversationId);
			return parsed.id;
		}
	} catch (err: unknown) {
		console.warn(
			`[SubthreadSpawner] Failed to spawn BB child thread for conversation ${args.conversationId}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
	return undefined;
}
