/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { fork } from 'child_process';
import { once } from 'events';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { inspect } from 'util';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NativeParsedArgs } from '../../../environment/common/argv.js';
import { OPTIONS, parseArgs } from '../../../environment/node/argv.js';
import { RemoteConnectionTokenFile, validateRemoteConnectionTokenArguments, WindowRemoteConnectionTokens } from '../../node/remoteConnectionToken.js';

suite('Remote connection token file', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let directory: string;
	let file: string;
	const authority = '127.0.0.1:8000';
	const secret = 'test_TOKEN-0123456789';

	setup(async () => {
		directory = await fs.mkdtemp(join(tmpdir(), 'vscode-remote-token-'));
		file = join(directory, 'token');
	});

	teardown(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	function args(): NativeParsedArgs {
		return { _: ['/project'], remote: authority, 'remote-token-file': file };
	}

	async function credential(): Promise<RemoteConnectionTokenFile> {
		await fs.writeFile(file, secret, { mode: 0o600 });
		return (await RemoteConnectionTokenFile.read(args()))!;
	}

	test('absent option preserves unauthenticated and resolver launches', async () => {
		assert.deepStrictEqual(await Promise.all([
			RemoteConnectionTokenFile.read({ _: [] }),
			RemoteConnectionTokenFile.read({ _: [], remote: authority }),
			RemoteConnectionTokenFile.read({ _: [], remote: 'ssh-remote+host' })
		]), [undefined, undefined, undefined]);
	});

	test('server token alphabet and optional final LF or CRLF', async () => {
		for (const ending of ['', '\n', '\r\n']) {
			await fs.writeFile(file, secret + ending);
			assert.strictEqual(await (await RemoteConnectionTokenFile.read(args()))!.getValue(authority), secret);
		}
	});

	test('rejects empty, whitespace, multiple lines and invalid characters without disclosing input', async () => {
		for (const value of ['', '\n', ' ', secret + '\n\n', secret + '\r', secret + '!', '\uFEFF' + secret, secret + '\nother']) {
			await fs.writeFile(file, value);
			await assert.rejects(RemoteConnectionTokenFile.read(args()), error => {
				assert.ok(error instanceof Error);
				assert.ok(!error.message.includes(secret));
				return /non-empty token/.test(error.message);
			});
		}
	});

	test('missing file and directory fail without exposing filesystem errors', async () => {
		await assert.rejects(RemoteConnectionTokenFile.read(args()), /Unable to read the local remote connection token file/);
		await fs.mkdir(file);
		await assert.rejects(RemoteConnectionTokenFile.read(args()), /Unable to read the local remote connection token file/);
	});

	test('rejects missing, resolver and malformed destinations', () => {
		for (const remote of [undefined, '', 'ssh-remote+host', 'host', 'host:0', 'host:65536', 'host:12/path', 'user@host:22', ':22', 'host:22\n']) {
			assert.throws(() => validateRemoteConnectionTokenArguments({ ...args(), remote }), /requires an absolute local file path and --remote host:port/);
		}
		validateRemoteConnectionTokenArguments({ ...args(), remote: '[::1]:8000' });
	});

	test('rejects empty and relative file arguments, including an empty CLI value', () => {
		for (const value of ['', 'relative/token']) {
			assert.throws(() => validateRemoteConnectionTokenArguments({ ...args(), 'remote-token-file': value }));
		}
		const parsed = parseArgs(['--remote', authority, '--remote-token-file'], OPTIONS);
		assert.throws(() => validateRemoteConnectionTokenArguments(parsed));
	});

	test('rejects incompatible arguments before opening any window', () => {
		const incompatible: Partial<NativeParsedArgs>[] = [
			{ add: true }, { remove: true }, { 'open-url': true }, { 'folder-uri': ['file:///project'] },
			{ 'file-uri': ['vscode-remote://other:8000/file'] }, { extensionDevelopmentPath: ['/extension'] },
			{ status: true }, { 'install-extension': ['publisher.extension'] }, { 'serve-web': {} }
		];
		for (const option of incompatible) {
			assert.throws(() => validateRemoteConnectionTokenArguments({ ...args(), ...option }), /cannot be combined/);
		}
	});

	test('serialized launch arguments contain only the path and are revalidated', async () => {
		await credential();
		const serialized = JSON.stringify(parseArgs(['--remote', authority, '--remote-token-file', file, '/project'], OPTIONS));
		assert.ok(!serialized.includes(secret));
		assert.strictEqual(await (await RemoteConnectionTokenFile.read(JSON.parse(serialized)))!.getValue(authority), secret);
		await fs.unlink(file);
		await assert.rejects(RemoteConnectionTokenFile.read(JSON.parse(serialized)), /Unable to read/);
	});

	test('a running process retains the forwarded path and rejects a file removed before reload', async () => {
		await credential();
		const child = fork(fileURLToPath(new URL('./fixtures/remoteConnectionTokenProcess.js', import.meta.url)), [], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
		});
		const exited = once(child, 'exit');
		try {
			const loaded = once(child, 'message');
			child.send(args());
			assert.deepStrictEqual((await loaded)[0], { authenticated: true, isolated: true });
			await fs.unlink(file);
			const reloaded = once(child, 'message');
			child.send({ _: [], remote: authority });
			assert.deepStrictEqual((await reloaded)[0], { rejected: true });
			const rejected = once(child, 'message');
			child.send(args());
			assert.deepStrictEqual((await rejected)[0], { rejected: true });
		} finally {
			child.kill();
			await exited;
		}
	});

	test('token cannot appear in JSON or ordinary diagnostic inspection', async () => {
		const token = await credential();
		assert.ok(!JSON.stringify(token).includes(secret));
		assert.ok(!inspect(token).includes(secret));
		await assert.rejects(token.getValue('127.0.0.1:8001'), /does not belong/);
	});

	test('reload and reconnection reread the file, observe replacement and reject deletion', async () => {
		const tokens = new WindowRemoteConnectionTokens<object>();
		const window = {};
		tokens.bind(window, authority, await credential());
		assert.strictEqual(await tokens.get(window, authority), secret);
		await fs.writeFile(file, 'replacement');
		assert.strictEqual(tokens.bind(window, authority), true);
		assert.strictEqual(await tokens.get(window, authority), 'replacement');
		await fs.unlink(file);
		await assert.rejects(tokens.get(window, authority), /Unable to read/);
	});

	test('a late file failure occurs during resolution, not while creating the window source', async () => {
		const source = RemoteConnectionTokenFile.fromArgs(args())!;
		const tokens = new WindowRemoteConnectionTokens<object>();
		const window = {};
		assert.strictEqual(tokens.bind(window, authority, source), true);
		await assert.rejects(tokens.get(window, authority), /Unable to read/);
		await fs.writeFile(file, 'valid');
		assert.strictEqual(await tokens.get(window, authority), 'valid');
		await fs.writeFile(file, 'invalid token');
		await assert.rejects(tokens.get(window, authority), /non-empty token/);
	});

	test('host casing follows existing window lookup without accepting a different port', async () => {
		await credential();
		const source = RemoteConnectionTokenFile.fromArgs({ ...args(), remote: 'LOCALHOST:8000' })!;
		const tokens = new WindowRemoteConnectionTokens<object>();
		const window = {};
		tokens.bind(window, 'localhost:8000', source);
		assert.strictEqual(await tokens.get(window, 'localhost:8000'), secret);
		await assert.rejects(tokens.get(window, 'localhost:8001'), /does not belong/);
	});

	test('same source can reuse a window, but a failed read or different source requires recovery', async () => {
		const tokens = new WindowRemoteConnectionTokens<object>();
		const window = {};
		const source = await credential();
		tokens.bind(window, authority, source);
		assert.strictEqual(tokens.canReuse(window, authority, source), true);
		const otherFile = join(directory, 'other-token');
		await fs.writeFile(otherFile, secret);
		const other = (await RemoteConnectionTokenFile.read({ ...args(), 'remote-token-file': otherFile }))!;
		assert.strictEqual(tokens.canReuse(window, authority, other), false);
		await fs.unlink(file);
		await assert.rejects(tokens.get(window, authority));
		assert.strictEqual(tokens.canReuse(window, authority, source), false);
	});

	test('a token read cannot complete for a window that has since changed destination', async () => {
		const tokens = new WindowRemoteConnectionTokens<object>();
		const window = {};
		tokens.bind(window, authority, await credential());
		const pending = tokens.get(window, authority);
		tokens.bind(window, 'other:8000');
		await assert.rejects(pending, /changed while reading/);
	});

	test('credentials are isolated by window and destination and dropped on window reuse', async () => {
		const tokens = new WindowRemoteConnectionTokens<object>();
		const window = {};
		tokens.bind(window, authority, await credential());
		assert.strictEqual(await tokens.get({}, authority), undefined);
		await assert.rejects(tokens.get(window, '127.0.0.1:8001'), /does not belong/);
		tokens.bind(window, '127.0.0.1:8001');
		tokens.bind(window, authority);
		assert.strictEqual(await tokens.get(window, authority), undefined);
		tokens.bind(window, authority, await credential());
		tokens.bind(window, undefined);
		await assert.rejects(tokens.get(window, authority), /does not belong/);
	});

	test('restored windows fail closed until a new launch supplies a credential', async () => {
		const tokens = new WindowRemoteConnectionTokens<object>();
		const window = {};
		tokens.bind(window, authority, undefined, true);
		await assert.rejects(tokens.get(window, authority), /Launch it again/);
		tokens.bind(window, authority); // Reload must not clear the requirement.
		await assert.rejects(tokens.get(window, authority), /Launch it again/);
		tokens.bind(window, authority, await credential());
		assert.strictEqual(await tokens.get(window, authority), secret);
	});

	test('a new launch can replace a credential only for its exact destination', async () => {
		const tokens = new WindowRemoteConnectionTokens<object>();
		const window = {};
		const token = await credential();
		assert.throws(() => tokens.bind(window, 'other:8000', token), /does not belong/);
		assert.strictEqual(await tokens.get(window, authority), undefined);
		tokens.bind(window, authority, token);
		await fs.writeFile(file, 'replacement');
		tokens.bind(window, authority, (await RemoteConnectionTokenFile.read(args()))!);
		assert.strictEqual(await tokens.get(window, authority), 'replacement');
	});
});
