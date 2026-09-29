export declare const SECRET_PATTERNS: Array<[RegExp, string, string]>;
export declare function redactSecrets(text: string): string;
export declare function scanArtifactSecrets(path: string, content: string | Buffer): string[];
export declare function structuredArtifactViolations(path: string, content: string | Buffer): string[];
export declare function isBinaryArtifactContent(value: string | Buffer): boolean;
export declare function scanForSecrets(value: string | Buffer): string[];
