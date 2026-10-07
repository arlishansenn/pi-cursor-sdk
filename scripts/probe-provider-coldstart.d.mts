export declare function buildScenarioChildEnv(
	scenario: { label: string; settingSources: string; turns: number },
	apiKey: string,
	baseEnv?: NodeJS.ProcessEnv,
	nodePath?: string,
): NodeJS.ProcessEnv;

export declare function runScenarioChildProcess(options: {
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	cwd?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
}): Promise<{
	ok: boolean;
	timedOut: boolean;
	truncated: boolean;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: string | null;
	spawnError?: string;
	/** Present when canonical process-tree cleanup failed; ok is false. */
	cleanupError?: string;
	pid: number | undefined;
}>;
