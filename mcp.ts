// mcp.ts: the Model Context Protocol endpoint (POST /mcp, JSON-RPC 2.0 over streamable HTTP). It speaks
// revision 2026-07-28 (server/discover, per-request _meta, no session) and the handshake revisions
// (initialize + notifications/initialized, an Mcp-Session-Id). The tools follow github-mcp-server's names
// and arguments and act on forge.ts's store, so their objects are the REST objects.

import { randomBytes } from 'node:crypto';
import * as F from './forge.ts';

const SERVER_INFO = Object.freeze({ name: 'makefun-forge', title: 'Forge MCP server', version: '1.0.0' });
const MODERN = '2026-07-28';
const SUPPORTED = [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CAPABILITIES = Object.freeze({ tools: { listChanged: false } });
const INSTRUCTIONS = 'A GitHub-compatible forge. Repositories belong to the authenticated user; use owner/repo arguments as on GitHub.';

const JSON_TYPE = 'application/json; charset=utf-8';

class ToolError extends Error {}

// ------------------------------------------------------------------ argument helpers

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description });
const OWNER = str('Repository owner (the user login)');
const REPO = str('Repository name');

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function text(args, name, required = false) {
  const value = args[name];
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolError(`missing required parameter: ${name}`);
    return undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') throw new ToolError(`parameter ${name} must be a string`);
  return value;
}

function integer(args, name, required = false) {
  const value = args[name];
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolError(`missing required parameter: ${name}`);
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new ToolError(`parameter ${name} must be an integer`);
  return parsed;
}

function repoOf(args) {
  let owner = text(args, 'owner');
  let name = text(args, 'repo');
  const full = text(args, 'full_name');
  if ((!owner || !name) && full && full.includes('/')) [owner, name] = full.split('/', 2);
  if (!owner) throw new ToolError('missing required parameter: owner');
  if (!name) throw new ToolError('missing required parameter: repo');
  const repo = F.getRepo(owner, name);
  if (!repo) throw new ToolError(`repository ${owner}/${name} not found`);
  return repo;
}

function issueOf(repo, number) {
  const issue = repo.issues.get(number);
  if (!issue) throw new ToolError(`issue #${number} not found in ${F.VIEWER.login}/${repo.name}`);
  return issue;
}

function pullOf(repo, number) {
  const pull = repo.pulls.get(number);
  if (!pull) throw new ToolError(`pull request #${number} not found in ${F.VIEWER.login}/${repo.name}`);
  return pull;
}

function paged(list, args) {
  const perPage = Math.min(100, Math.max(1, integer(args, 'perPage') ?? integer(args, 'per_page') ?? 30));
  const page = Math.max(1, integer(args, 'page') ?? 1);
  return list.slice((page - 1) * perPage, page * perPage);
}

const PAGING = { page: num('Page number for pagination (min 1)'), perPage: num('Results per page for pagination (min 1, max 100)') };

// ------------------------------------------------------------------ the tools

const TOOLS = [
  {
    name: 'get_me',
    description: 'Get details of the authenticated user.',
    inputSchema: schema({}),
    run: (args, origin) => F.fullUserJson(origin),
  },
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: schema({ name: str('Repository name'), description: str('Repository description'), private: bool('Whether the repository is private'), autoInit: bool('Initialize with a README') }, ['name']),
    run: (args, origin) => F.repoJson(F.createRepo({ name: text(args, 'name', true), description: text(args, 'description'), private: args.private === true || args.private === 'true', auto_init: args.autoInit === true }), origin),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: schema({ owner: OWNER, repo: REPO }, ['owner', 'repo']),
    run: (args, origin) => F.repoJson(repoOf(args), origin),
  },
  {
    name: 'search_repositories',
    description: 'Search the authenticated user\'s repositories by name or description.',
    inputSchema: schema({ query: str('Search query'), ...PAGING }, ['query']),
    run: (args, origin) => {
      const words = String(text(args, 'query', true)).toLowerCase().split(/\s+/).filter((word) => word && !word.includes(':'));
      const items = F.listRepos().filter((repo) => words.every((word) => `${repo.name} ${repo.description ?? ''}`.toLowerCase().includes(word)));
      return { total_count: items.length, incomplete_results: false, items: paged(items, args).map((repo) => F.repoJson(repo, origin)) };
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: schema({ owner: OWNER, repo: REPO, title: str('Issue title'), body: str('Issue body content'), labels: strList('Labels to apply (must exist)'), assignees: strList('Usernames to assign') }, ['owner', 'repo', 'title']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const title = text(args, 'title', true);
      return F.issueJson(repo, F.createIssue(repo, { title, body: text(args, 'body'), labels: args.labels, assignees: args.assignees }), origin);
    },
  },
  {
    name: 'get_issue',
    description: 'Get the details of an issue in a repository.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: num('The number of the issue') }, ['owner', 'repo', 'issue_number']),
    run: (args, origin) => {
      const repo = repoOf(args);
      return F.issueJson(repo, issueOf(repo, integer(args, 'issue_number', true)), origin);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, filtered by state and labels.',
    inputSchema: schema({ owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all', 'OPEN', 'CLOSED'], description: 'Filter by state' }, labels: strList('Filter by labels'), sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: 'Sort order' }, direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction' }, ...PAGING }, ['owner', 'repo']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const list = F.queryIssues(repo, {
        state: (text(args, 'state') ?? 'open').toLowerCase(),
        sort: text(args, 'sort') ?? 'created',
        direction: text(args, 'direction') ?? 'desc',
        labels: Array.isArray(args.labels) && args.labels.length ? args.labels.map(String) : null,
      });
      return paged(list, args).map((issue) => F.issueJson(repo, issue, origin));
    },
  },
  {
    name: 'update_issue',
    description: 'Update an existing issue: title, body, state or labels.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: num('Issue number to update'), title: str('New title'), body: str('New description'), state: { type: 'string', enum: ['open', 'closed'], description: 'New state' }, labels: strList('New labels') }, ['owner', 'repo', 'issue_number']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const issue = issueOf(repo, integer(args, 'issue_number', true));
      const patch = {};
      for (const key of ['title', 'body', 'state']) if (args[key] !== undefined) patch[key] = text(args, key);
      if (args.labels !== undefined) patch.labels = args.labels;
      return F.issueJson(repo, F.updateIssue(repo, issue, patch), origin);
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: num('Issue number to comment on'), body: str('Comment content') }, ['owner', 'repo', 'issue_number', 'body']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const number = integer(args, 'issue_number', true);
      return F.commentJson(repo, origin, F.addComment(repo, number, text(args, 'body', true)));
    },
  },
  {
    name: 'get_issue_comments',
    description: 'List the comments on an issue.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: num('Issue number'), ...PAGING }, ['owner', 'repo', 'issue_number']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const number = integer(args, 'issue_number', true);
      if (!repo.issues.has(number) && !repo.pulls.has(number)) throw new ToolError(`issue #${number} not found`);
      return paged(repo.comments.get(number) ?? [], args).map((comment) => F.commentJson(repo, origin, comment));
    },
  },
  {
    name: 'search_issues',
    description: 'Search issues and pull requests across the user\'s repositories (supports repo:, is:, state: and label: qualifiers).',
    inputSchema: schema({ query: str('Search query'), ...PAGING }, ['query']),
    run: (args, origin) => {
      const query = String(text(args, 'query', true));
      const tokens = query.split(/\s+/).filter(Boolean);
      const words = tokens.filter((token) => !token.includes(':')).map((token) => token.toLowerCase());
      const qualifier = (key) => tokens.filter((token) => token.toLowerCase().startsWith(`${key}:`)).map((token) => token.slice(key.length + 1));
      let repos = F.listRepos();
      if (qualifier('repo').length) repos = qualifier('repo').map((full) => F.getRepo(...full.split('/'))).filter(Boolean);
      const is = new Set(qualifier('is').map((value) => value.toLowerCase()));
      const items = [];
      for (const repo of repos) {
        for (const issue of repo.issues.values()) {
          if (is.has('pr')) continue;
          if ((is.has('open') && issue.state !== 'open') || (is.has('closed') && issue.state !== 'closed')) continue;
          if (!words.every((word) => `${issue.title} ${issue.body ?? ''}`.toLowerCase().includes(word))) continue;
          items.push(F.issueJson(repo, issue, origin));
        }
      }
      return { total_count: items.length, incomplete_results: false, items: paged(items, args) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a new pull request from a head branch into a base branch.',
    inputSchema: schema({ owner: OWNER, repo: REPO, title: str('PR title'), body: str('PR description'), head: str('Branch containing the changes'), base: str('Branch to merge into'), draft: bool('Create as draft PR') }, ['owner', 'repo', 'title', 'head', 'base']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const pull = F.createPull(repo, { title: text(args, 'title', true), body: text(args, 'body'), head: text(args, 'head', true), base: text(args, 'base', true), draft: args.draft === true });
      return F.pullJson(repo, pull, origin);
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get the details of a pull request.',
    inputSchema: schema({ owner: OWNER, repo: REPO, pull_number: num('Pull request number') }, ['owner', 'repo', 'pull_number']),
    run: (args, origin) => {
      const repo = repoOf(args);
      return F.pullJson(repo, pullOf(repo, integer(args, 'pull_number', true)), origin);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: schema({ owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state' }, head: str('Filter by head branch'), base: str('Filter by base branch'), ...PAGING }, ['owner', 'repo']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const list = F.queryPulls(repo, { state: (text(args, 'state') ?? 'open').toLowerCase(), head: text(args, 'head') ?? null, base: text(args, 'base') ?? null });
      return paged(list, args).map((pull) => F.pullJson(repo, pull, origin, false));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (merge, squash or rebase).',
    inputSchema: schema({ owner: OWNER, repo: REPO, pull_number: num('Pull request number'), merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method' }, commit_title: str('Title for the merge commit'), commit_message: str('Extra detail for the merge commit') }, ['owner', 'repo', 'pull_number']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const pull = pullOf(repo, integer(args, 'pull_number', true));
      const result = F.mergePull(repo, pull, { method: text(args, 'merge_method') ?? 'merge', title: text(args, 'commit_title'), message: text(args, 'commit_message') });
      return { ...result, pull_request: F.pullJson(repo, pull, origin, false) };
    },
  },
  {
    name: 'update_pull_request',
    description: 'Update a pull request: title, body, state or base branch.',
    inputSchema: schema({ owner: OWNER, repo: REPO, pull_number: num('Pull request number'), title: str('New title'), body: str('New description'), state: { type: 'string', enum: ['open', 'closed'], description: 'New state' }, base: str('New base branch') }, ['owner', 'repo', 'pull_number']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const pull = pullOf(repo, integer(args, 'pull_number', true));
      const patch = {};
      for (const key of ['title', 'body', 'state', 'base']) if (args[key] !== undefined) patch[key] = text(args, key);
      return F.pullJson(repo, F.updatePull(repo, pull, patch), origin);
    },
  },
  {
    name: 'get_pull_request_files',
    description: 'List the files changed in a pull request.',
    inputSchema: schema({ owner: OWNER, repo: REPO, pull_number: num('Pull request number'), ...PAGING }, ['owner', 'repo', 'pull_number']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const pull = pullOf(repo, integer(args, 'pull_number', true));
      const head = F.pullTips(repo, pull).head;
      return paged(F.pullFiles(repo, pull), args).map((file) => F.pullFileJson(repo, origin, file, head));
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository.',
    inputSchema: schema({ owner: OWNER, repo: REPO, ...PAGING }, ['owner', 'repo']),
    run: (args, origin) => {
      const repo = repoOf(args);
      return paged(repo.git.branchNames(), args).map((name) => F.branchJson(repo, origin, name));
    },
  },
  {
    name: 'create_branch',
    description: 'Create a new branch from an existing branch (the default branch when from_branch is omitted).',
    inputSchema: schema({ owner: OWNER, repo: REPO, branch: str('Name for the new branch'), from_branch: str('Source branch (defaults to the repository default branch)') }, ['owner', 'repo', 'branch']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const branch = text(args, 'branch', true);
      const from = text(args, 'from_branch') ?? F.defaultBranch(repo);
      const sha = repo.git.refs.get(`refs/heads/${from}`);
      if (!sha) throw new ToolError(`branch ${from} not found`);
      if (repo.git.refs.has(`refs/heads/${branch}`)) throw new ToolError(`branch ${branch} already exists`);
      repo.git.refs.set(`refs/heads/${branch}`, sha);
      repo.git.touch();
      F.onPush(repo);
      return F.refJson(repo, origin, `refs/heads/${branch}`);
    },
  },
  {
    name: 'list_commits',
    description: 'List the commits of a branch, tag or commit sha.',
    inputSchema: schema({ owner: OWNER, repo: REPO, sha: str('Branch, tag or commit sha to list from'), ...PAGING }, ['owner', 'repo']),
    run: (args, origin) => {
      const repo = repoOf(args);
      if (repo.git.isEmpty()) return [];
      const tip = repo.git.resolve(text(args, 'sha'));
      if (!tip) throw new ToolError(`no commit found for ${text(args, 'sha')}`);
      return paged(repo.git.log(tip, 1000), args).map((oid) => F.commitJson(repo, origin, oid));
    },
  },
  {
    name: 'get_file_contents',
    description: 'Get the contents of a file, or the listing of a directory, at a ref.',
    inputSchema: schema({ owner: OWNER, repo: REPO, path: str('Path to the file or directory'), ref: str('Branch, tag or commit sha') }, ['owner', 'repo']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const path = (text(args, 'path') ?? '').replace(/^\/+|\/+$/g, '');
      const ref = text(args, 'ref');
      const tip = repo.git.resolve(ref);
      if (!tip) throw new ToolError(repo.git.isEmpty() ? 'repository is empty' : `ref ${ref} not found`);
      const entry = repo.git.lookupPath(tip, path);
      if (!entry) throw new ToolError(`path ${path} not found`);
      if (entry.type === 'tree') {
        return (repo.git.tree(entry.oid) ?? []).map((child) => F.contentEntryJson(repo, origin, path ? `${path}/${child.name}` : child.name, { type: child.mode === '40000' ? 'tree' : 'blob', mode: child.mode, oid: child.oid }, ref));
      }
      const data = repo.git.get(entry.oid).data;
      return { ...F.contentEntryJson(repo, origin, path, entry, ref), encoding: 'utf-8', content: data.toString('utf8') };
    },
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update a single file in a repository with a commit (sha required when updating).',
    inputSchema: schema({ owner: OWNER, repo: REPO, path: str('Path where to create/update the file'), content: str('Content of the file (plain text)'), message: str('Commit message'), branch: str('Branch to commit to'), sha: str('Blob sha of the file being replaced (required for updates)') }, ['owner', 'repo', 'path', 'content', 'message']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const result = F.putContents(repo, text(args, 'path', true), {
        message: text(args, 'message', true),
        content: Buffer.from(text(args, 'content', true) ?? '', 'utf8').toString('base64'),
        branch: text(args, 'branch'),
        sha: text(args, 'sha'),
      });
      return {
        content: F.contentEntryJson(repo, origin, result.path, { type: 'blob', mode: '100644', oid: result.blobOid }, null),
        commit: F.gitCommitJson(repo, origin, result.commitOid),
      };
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from a repository with a commit.',
    inputSchema: schema({ owner: OWNER, repo: REPO, path: str('Path to the file to delete'), message: str('Commit message'), branch: str('Branch to delete the file from') }, ['owner', 'repo', 'path', 'message']),
    run: (args, origin) => {
      const repo = repoOf(args);
      const path = text(args, 'path', true);
      const branch = text(args, 'branch') ?? F.defaultBranch(repo);
      const tip = repo.git.refs.get(`refs/heads/${branch}`);
      const entry = tip ? repo.git.lookupPath(tip, path) : null;
      if (!entry || entry.type !== 'blob') throw new ToolError(`file ${path} not found on ${branch}`);
      const result = F.deleteContents(repo, path, { message: text(args, 'message', true), sha: entry.oid, branch });
      return { content: null, commit: F.gitCommitJson(repo, origin, result.commitOid) };
    },
  },
  {
    name: 'list_labels',
    description: 'List the labels defined in a repository.',
    inputSchema: schema({ owner: OWNER, repo: REPO }, ['owner', 'repo']),
    run: (args, origin) => {
      const repo = repoOf(args);
      return [...repo.labels.values()].map((label) => F.labelJson(repo, origin, label));
    },
  },
  {
    name: 'create_label',
    description: 'Create a label in a repository.',
    inputSchema: schema({ owner: OWNER, repo: REPO, name: str('Label name'), color: str('Six-digit hex color'), description: str('Label description') }, ['owner', 'repo', 'name']),
    run: (args, origin) => {
      const repo = repoOf(args);
      return F.labelJson(repo, origin, F.createLabel(repo, { name: text(args, 'name', true), color: text(args, 'color'), description: text(args, 'description') }));
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const TOOL_LIST = Object.freeze(TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));

// ------------------------------------------------------------------ JSON-RPC

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function toolResult(value, isError) {
  const textValue = typeof value === 'string' ? value : JSON.stringify(value);
  const result = { content: [{ type: 'text', text: textValue }], isError: isError === true };
  if (!isError && value !== null && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value;
  return result;
}

function callTool(params, origin) {
  const name = typeof params?.name === 'string' ? params.name : '';
  const tool = TOOL_BY_NAME.get(name) ?? TOOL_BY_NAME.get(name.replace(/^.*__/, '').toLowerCase());
  if (!tool) return { error: [-32602, `Unknown tool: ${name}`] };
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
  try {
    return { result: toolResult(tool.run(args, origin), false) };
  } catch (err) {
    if (err instanceof ToolError || err instanceof F.ForgeError) {
      const detail = err instanceof F.ForgeError && err.errors && err.errors[0]?.message ? `${err.message}: ${err.errors[0].message}` : err.message;
      return { result: toolResult(`error: ${detail}`, true) };
    }
    return { result: toolResult(`internal error: ${err && err.message ? err.message : String(err)}`, true) };
  }
}

/** Answer one JSON-RPC message: a response object, or null for a notification. */
function answer(message, origin, session) {
  if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message && typeof message === 'object' ? message.id : null, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in message) || message.id === undefined;
  const id = message.id;
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (isNotification) return null;
  switch (message.method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED[1];
      const protocolVersion = SUPPORTED.includes(requested) ? requested : SUPPORTED[1];
      session.created = true;
      return rpcResult(id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOL_LIST });
    case 'tools/call': {
      const outcome = callTool(params, origin);
      if (outcome.error) return rpcError(id, outcome.error[0], outcome.error[1]);
      return rpcResult(id, outcome.result);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    case 'logging/setLevel':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}

/** POST/GET/DELETE /mcp after authentication: {status, contentType, body, headers}. */
export function handleMcp(req, body, origin) {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') return { status: 204, contentType: JSON_TYPE, body: '', headers: undefined };
  if (method !== 'POST') return { status: 405, contentType: JSON_TYPE, body: JSON.stringify(rpcError(null, -32000, 'Method not allowed: use POST')), headers: { allow: 'POST, DELETE' } };
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, contentType: JSON_TYPE, body: JSON.stringify(rpcError(null, -32700, 'Parse error')), headers: undefined };
  }
  const session = { created: false };
  let reply;
  if (Array.isArray(payload)) {
    if (payload.length === 0) reply = rpcError(null, -32600, 'Invalid Request: empty batch');
    else {
      const answers = payload.map((message) => answer(message, origin, session)).filter((item) => item !== null);
      reply = answers.length ? answers : null;
    }
  } else {
    reply = answer(payload, origin, session);
  }
  const headers = {};
  if (session.created) headers['mcp-session-id'] = randomBytes(16).toString('hex');
  else if (typeof req.headers['mcp-session-id'] === 'string') headers['mcp-session-id'] = req.headers['mcp-session-id'];
  if (reply === null) return { status: 202, contentType: JSON_TYPE, body: '', headers };
  return { status: 200, contentType: JSON_TYPE, body: JSON.stringify(reply), headers };
}
